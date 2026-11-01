import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAdapter } from '../src/browser-adapter.mjs';
import { WorkspaceObserver } from '../src/workspace-observer.mjs';

function bridge(options = {}) {
  const tabs = new Map(); let fills = 0; let clicks = 0; let closes = 0; let text;
  const driver = {
    async openTab({ url }) { const tab = { tabId: tabs.size + 1, url, documentId: 'doc-1' }; tabs.set(tab.tabId, tab); return tab; },
    async readTab({ tabId }) { return tabs.get(tabId); },
    async fillComposer({ text: value }) { fills++; text = value; },
    async readComposer() { return options.badReadback ? 'different' : text; },
    async clickSend() { clicks++; },
    async observeAck({ idempotencyKey }) { if (options.lostAck) throw new Error('timeout'); return { acknowledged: true, idempotencyKey }; },
    async closeTab({ tabId }) { closes++; tabs.delete(tabId); },
  };
  const browser = new BrowserAdapter({ driver, allowedOrigins: ['http://127.0.0.1:4173'] });
  const counts = () => ({ fills, clicks, closes });
  return { browser, driver, tabs, counts };
}
const open = browser => browser.openOwned({ url: 'http://127.0.0.1:4173/fixture', ownerId: 'intent-1' });
const send = tab => ({ ...tab, idempotencyKey: 'key-1', prompt: 'line 1\nline 2\n中文', origin: 'http://127.0.0.1:4173' });

test('external actions require allowlist AND explicit opt-in', async () => {
  const { driver } = bridge();
  const browser = new BrowserAdapter({ driver, allowedOrigins: ['https://chatgpt.com'] });
  await assert.rejects(browser.openOwned({ url: 'https://chatgpt.com/', ownerId: 'a' }), /disabled/);
  await assert.rejects(browser.openOwned({ url: 'http://evil.invalid/', ownerId: 'a' }), /approved/);
});
test('legacy browser adapter cannot bypass native binding even with external origin opt-in',async()=>{
  const {driver,counts}=bridge();
  const browser=new BrowserAdapter({driver,allowedOrigins:['https://chatgpt.com'],allowExternal:true});
  const tab=await browser.openOwned({url:'https://chatgpt.com/c/synthetic-conversation',ownerId:'synthetic-intent'});
  await assert.rejects(browser.sendOnce({...tab,idempotencyKey:'synthetic',prompt:'synthetic goal',origin:'https://chatgpt.com'}),/Native task\/conversation dispatch contract unavailable/);
  assert.deepEqual(counts(),{fills:0,clicks:0,closes:0});
});

test('multiline preserved; concurrent duplicate requests cause one click', async () => {
  const { browser, counts } = bridge(); const request = send(await open(browser));
  const results = await Promise.all([browser.sendOnce(request), browser.sendOnce(request)]);
  assert.equal(results[0].acknowledged, true);
  assert.equal(results[1].acknowledged, true);
  assert.deepEqual(counts(), { fills: 1, clicks: 1, closes: 0 });
  await assert.rejects(browser.sendOnce({ ...request, prompt: 'changed' }), /conflict/);
});

test('lost ACK becomes unknown and is never resent', async () => {
  const { browser, counts } = bridge({ lostAck: true }); const request = send(await open(browser));
  assert.equal((await browser.sendOnce(request)).state, 'unknown');
  assert.equal((await browser.sendOnce(request)).state, 'unknown');
  assert.equal(counts().clicks, 1);
});

test('readback mismatch blocks click and remains guarded', async () => {
  const { browser, counts } = bridge({ badReadback: true }); const request = send(await open(browser));
  assert.equal((await browser.sendOnce(request)).state, 'unknown');
  assert.equal(counts().clicks, 0);
});

test('page refresh invalidates document identity and blocks send', async () => {
  const { browser, tabs, counts } = bridge(); const tab = await open(browser);
  tabs.get(tab.tabId).documentId = 'doc-2';
  await assert.rejects(browser.sendOnce(send(tab)), /navigated/);
  assert.equal(counts().clicks, 0);
});

test('user tabs, wrong owners, and cross-origin navigation are protected', async () => {
  const { browser, tabs } = bridge(); const tab = await open(browser);
  await assert.rejects(browser.observe({ ...tab, tabId: 99 }), /owned/);
  await assert.rejects(browser.observe({ ...tab, ownerId: 'somebody-else' }), /owned/);
  tabs.get(tab.tabId).url = 'https://evil.invalid/';
  await assert.rejects(browser.observe(tab), /navigated/);
});

test('close requires owned unchanged tab and verified terminal producer', async () => {
  const { browser, counts } = bridge(); const tab = await open(browser);
  const args = { ...tab, dispatchState: 'sent', providerState: 'succeeded', verified: true };
  await assert.rejects(browser.safeClose({ ...args, dispatchState: 'unknown' }), /protects/);
  await assert.rejects(browser.safeClose({ ...args, providerState: 'running' }), /protects/);
  await assert.rejects(browser.safeClose({ ...args, verified: false }), /protects/);
  assert.deepEqual(await browser.safeClose(args), { closed: true, canceledJob: false });
  assert.equal(counts().closes, 1);
});

function receipt(overrides = {}) {
  return { idempotencyKey: 'key', invocationId: 'inv', source: 'owner', observationId: 'receipt-1', observedAt: '2026-01-01T00:00:00Z', router: { state: 'completed' }, verified: true, ...overrides };
}
const observer = raw => new WorkspaceObserver({ source: 'owner', readByKey: async () => raw });
test('router completion never invents a provider completion', async () => {
  const result = await observer(receipt()).observe({ idempotencyKey: 'key' });
  assert.equal(result.router.state, 'completed');
  assert.equal(result.provider, undefined);
  assert.equal(result.verified, true); // trusted router observation, not business completion
});
test('empty or missing provenance produces no observation', async () => {
  for (const raw of [null, receipt({ source: 'other' }), receipt({ observedAt: 'bad' })]) {
    const result = await observer(raw).observe({ idempotencyKey: 'key' });
    assert.equal(result, null);
  }
});
test('mismatched idempotency/invocation receipts rejected', async () => {
  await assert.rejects(observer(receipt()).observe({ idempotencyKey: 'different' }), /correlation/);
  await assert.rejects(observer(receipt()).observe({ idempotencyKey: 'key', invocationId: 'wrong' }), /correlation/);
});
test('provider ids remain distinct and only explicit evidence is verified', async () => {
  const provider = { state: 'succeeded', taskId: 'task', runId: 'run', sessionId: 'session' };
  const unverified = await observer(receipt({ provider })).observe({ idempotencyKey: 'key' });
  assert.equal(unverified.verified, true); // verified snapshot, no terminal evidence
  assert.equal(unverified.provider.evidence, undefined);
  const result = await observer(receipt({ provider: { ...provider, evidence: { authoritative: true, source: 'owner', reference: 'producer-receipt-1' } } })).observe({ idempotencyKey: 'key' });
  assert.equal(result.verified, true);
  assert.equal(result.provider.taskId, 'task'); assert.equal(result.provider.runId, 'run'); assert.equal(result.provider.sessionId, 'session');
});
test('separate provider read is exact and cannot change identity', async () => {
  let read;
  const obs = new WorkspaceObserver({ source: 'owner', readByKey: async () => receipt({ provider: { taskId: 'task', state: 'running' } }), readProvider: async args => { read = args; return { idempotencyKey: 'key', taskId: 'wrong', state: 'succeeded' }; } });
  await assert.rejects(obs.observe({ idempotencyKey: 'key' }), /correlation/);
  assert.deepEqual(read, { taskId: 'task', idempotencyKey: 'key' });
});

test('new producer observations get distinct merged identity and timestamp', async () => {
  let n = 0;
  const obs = new WorkspaceObserver({ source: 'owner', readByKey: async () => receipt({ provider: { taskId: 'task', state: 'running' } }),
    readProvider: async () => ({ idempotencyKey: 'key', taskId: 'task', state: ++n === 1 ? 'running' : 'succeeded', source: 'owner', observationId: `producer-${n}`, observedAt: `2026-01-01T00:00:0${n}Z`, verified: true, evidence: { authoritative: true, source: 'owner', reference: `evidence-${n}` } }) });
  const a = await obs.observe({ idempotencyKey: 'key' });
  const b = await obs.observe({ idempotencyKey: 'key' });
  assert.notEqual(a.observationId, b.observationId);
  assert.equal(b.observedAt, '2026-01-01T00:00:02Z');
  assert.equal(b.provider.state, 'succeeded'); assert.equal(b.verified, true);
});

test('unauthenticated provider response cannot inherit router verification', async () => {
  const provider = { idempotencyKey: 'key', taskId: 'task', state: 'succeeded', source: 'owner', observationId: 'producer', observedAt: '2026-01-01T00:00:01Z', verified: false, evidence: { authoritative: true, source: 'owner', reference: 'evidence' } };
  const obs = new WorkspaceObserver({ source: 'owner', readByKey: async () => receipt({ provider: { taskId: 'task', state: 'running' } }), readProvider: async () => provider });
  const result = await obs.observe({ idempotencyKey: 'key' });
  assert.equal(result.verified, false); assert.equal(result.provider.evidence, undefined);
  provider.source = 'other';
  await assert.rejects(obs.observe({ idempotencyKey: 'key' }), /provenance/);
});

test('unverified router observations never acquire provider trust', async () => {
  const obs = observer(receipt({ verified: false, provider: { taskId: 'task', state: 'succeeded', evidence: { authoritative: true, source: 'owner', reference: 'evidence' } } }));
  const result = await obs.observe({ idempotencyKey: 'key' });
  assert.equal(result.verified, false); assert.equal(result.provider.evidence, undefined);
});
