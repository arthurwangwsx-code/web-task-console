import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IntentEngine } from '../src/engine.mjs';
import { MemoryStore, JsonStore } from '../src/store.mjs';
import { DemoAdapter } from '../src/demo-adapter.mjs';

async function fixture(config = {}) {
  let now = 100000;
  const store = new MemoryStore(); const adapter = await new DemoAdapter(new MemoryStore()).open();
  const engine = await new IntentEngine({ store, adapter, config: { minDispatchIntervalMs: 0, ...config }, clock: () => now, random: () => 0.5 }).open();
  return { engine, adapter, store, advance: n => { now += n; }, add: (key = 'test', extra = {}) => engine.enqueue({ idempotencyKey: key, prompt: 'Synthetic first line\n第二行\nlast line', ...extra }) };
}
test('durable idempotency: duplicate returns same intent; changed payload conflicts', async () => {
  const f = await fixture(); const a = await f.add(); const b = await f.add(); assert.equal(a.id, b.id);
  await assert.rejects(f.add('test', { prompt: 'different' }), /IDEMPOTENCY_KEY_CONFLICT/);
  await f.engine.tick(); await f.engine.tick(); assert.equal(f.adapter.state.sends, 1);
});
test('lost ACK is unknown, never resent; exact provider observation recovers it', async () => {
  const f = await fixture(); f.adapter.setScenario('lost-ack'); const i = await f.add();
  await f.engine.tick(); assert.equal(f.engine.snapshot().intents[0].status, 'unknown');
  for (let n = 0; n < 3; n++) await f.engine.tick();
  assert.equal(f.adapter.state.sends, 1); await assert.rejects(f.engine.closeTab(`tab-${i.id}`), /TAB_PROTECTED/);
  const done = await f.engine.reconcile(i.id); assert.equal(done.status, 'succeeded'); assert.equal(done.dispatch.recoveredByObservation, true);
  assert.equal((await f.engine.closeTab(done.tabId)).state, 'closed');
});
test('no observation is not proof of no execution; backoff and protection survive', async () => {
  const f = await fixture(); f.adapter.setScenario('no-receipt'); const i = await f.add(); await f.engine.tick();
  const read = await f.engine.reconcile(i.id); assert.equal(read.status, 'unknown'); assert.equal(read.poll.failures, 1);
  await assert.rejects(f.engine.reconcile(i.id), /BACKOFF/); f.advance(1001); await f.engine.reconcile(i.id);
  assert.equal(f.engine.snapshot().intents[0].poll.failures, 2); assert.equal(f.adapter.state.sends, 1);
  await assert.rejects(f.engine.cancelQueued(i.id), /ONLY_UNSENT/);
});
test('router completed does not mean provider business success or permit closing', async () => {
  const f = await fixture(); f.adapter.setScenario('router-only'); const i = await f.add(); await f.engine.tick();
  const observed = await f.engine.reconcile(i.id); assert.equal(observed.router.state, 'completed'); assert.equal(observed.provider.state, 'unobserved');
  assert.equal(observed.status, 'awaiting-provider'); assert.equal(observed.completion.verified, false);
  await assert.rejects(f.engine.closeTab(observed.tabId), /TAB_PROTECTED/);
});
test('provider failure is terminal and remains distinct from success', async () => {
  const f = await fixture(); f.adapter.setScenario('provider-failure'); const i = await f.add(); await f.engine.tick();
  const done = await f.engine.reconcile(i.id); assert.equal(done.status, 'failed'); assert.equal(done.completion.verified, true);
});
test('queue backpressure, independent active, scope, tab and receipt budgets', async () => {
  const q = await fixture({ maxQueued: 1 }); await q.add(); await assert.rejects(q.add('two'), /QUEUE_FULL/);
  const a = await fixture({ maxActive: 1 }); await a.add(); await a.add('two', { scope: 'other' }); await a.engine.tick(); assert.equal((await a.engine.tick()).reason, 'ACTIVE_CAPACITY');
  const s = await fixture(); await s.add(); await s.add('two'); await s.engine.tick(); assert.equal((await s.engine.tick()).reason, 'SCOPE_CAPACITY');
  const t = await fixture({ maxTabs: 1 }); const ti = await t.add(); await t.engine.tick(); await t.engine.reconcile(ti.id); await t.add('two'); assert.equal((await t.engine.tick()).reason, 'TAB_CAPACITY');
  const r = await fixture({ maxReceipts: 3 }); await r.add(); assert.equal((await r.engine.tick()).reason, 'RECEIPT_CAPACITY'); assert.equal(r.adapter.state.sends, 0);
});
test('fair queue skips blocked scope without starving a different scope', async () => {
  const f = await fixture(); await f.add('a1', { scope: 'a' }); await f.add('a2', { scope: 'a' }); const b = await f.add('b1', { scope: 'b' });
  await f.engine.tick(); assert.equal((await f.engine.tick()).intent.id, b.id);
});
test('pause, cancellation and dispatch interval are enforced', async () => {
  const f = await fixture({ minDispatchIntervalMs: 1000 }); const a = await f.add(); const b = await f.add('b', { scope: 'other' });
  await f.engine.setPaused(true); assert.equal((await f.engine.tick()).reason, 'PAUSED'); await f.engine.setPaused(false);
  await f.engine.tick(); assert.equal((await f.engine.tick()).reason, 'DISPATCH_RATE_LIMIT'); await f.engine.cancelQueued(b.id);
  await assert.rejects(f.engine.cancelQueued(a.id), /ONLY_UNSENT/);
});
test('concurrent ticks serialize: at most one send per intent', async () => {
  const f = await fixture(); await f.add(); await Promise.all(Array.from({ length: 20 }, () => f.engine.tick())); assert.equal(f.adapter.state.sends, 1);
});
test('unrelated tab, unapproved origin and malformed inputs rejected', async () => {
  const f = await fixture(); await assert.rejects(f.engine.closeTab('user-tab'), /TAB_NOT_OWNED/);
  await assert.rejects(f.add('no', { origin: 'https://chatgpt.com' }), /ORIGIN_NOT_APPROVED/);
  await assert.rejects(f.add('bad key'), /INVALID_IDEMPOTENCY_KEY/);
});
test('receipt conflicts, unverified claims and prose cannot create success', async () => {
  const f = await fixture(); const i = await f.add(); await f.engine.tick();
  f.adapter.observe = async () => ({ observationId:'fake', observedAt: new Date().toISOString(), source:'fake', idempotencyKey:'other', router:{state:'completed'}, provider:{state:'succeeded'}, verified:true });
  const r = await f.engine.reconcile(i.id); assert.equal(r.completion.verified, false); assert.match(r.poll.error, /UNCORRELATED/);
});
test('crash recovery turns durable sending into unknown and never dispatches again', async () => {
  const f = await fixture(); await f.add();
  f.store.value.intents[0].dispatch = { state:'sending', attempts:1 };
  const restarted = await new IntentEngine({ store:f.store, adapter:f.adapter }).open();
  assert.equal(restarted.snapshot().intents[0].status, 'unknown'); await restarted.tick(); assert.equal(f.adapter.state.sends, 0);
});
test('file persistence, refresh/restart recovery, lock safety and permissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'intent-test-'));
  try {
    const a = new JsonStore(dir); await a.open(); await a.save({version:1, synthetic:true});
    await assert.rejects(new JsonStore(dir).open(), /DATA_DIRECTORY_LOCKED/);
    assert.equal(JSON.parse(await readFile(path.join(dir,'intents.json'))).synthetic, true);
    await a.close(); const b = new JsonStore(dir); assert.equal((await b.open()).synthetic,true); await b.close();
  } finally { await rm(dir, {recursive:true,force:true}); }
});
