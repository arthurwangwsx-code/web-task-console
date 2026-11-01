import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Minimal synthetic DOM: verifies presentation gates, NOT Chrome/UI end-to-end.
const source = await readFile(new URL('../extension/console.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/console.html', import.meta.url), 'utf8');
function intent(extra = {}) {
  return { id: 'synthetic-intent', idempotencyKey: 'synthetic-key', prompt: 'Synthetic task', wirePrompt: 'Synthetic task\n[web-task-console key=synthetic-key]', state: 'ready', binding: { state: 'pending' }, messageEvidence: [], ...extra };
}
async function fixture(row = intent()) {
  const all = [], calls = [];
  class Element {
    constructor(tag) { Object.assign(this, { tagName: tag, dataset: {}, listeners: {}, children: [], value: '', textContent: '', disabled: false }); all.push(this); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    select() {}
  }
  const ids = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element('div')]));
  const state = { intents: [row], ownedTabs: [], config: {}, paused: false };
  const context = vm.createContext({
    document: { querySelector: selector => ids.get(selector.slice(1)), querySelectorAll: () => all.filter(node => ['button', 'input', 'textarea'].includes(node.tagName)), createElement: tag => new Element(tag) },
    chrome: { runtime: { sendMessage: async payload => { calls.push(structuredClone(payload)); return { ok: true, value: payload.op === 'state' ? state : state.intents[0] }; } }, permissions: { contains: async () => false } },
    crypto: { randomUUID: () => 'synthetic-ui-key' }, window: { confirm: () => true, prompt: () => null },
    setInterval: () => 0, Date, URL,
  });
  const ui = await new vm.Script(`(async()=>{${source}\nreturn {render,setBusy};})()`).runInContext(context);
  const walk = node => [node, ...node.children.flatMap(walk)];
  const visible = () => walk(ids.get('intents'));
  const find = label => visible().find(node => node.tagName === 'button' && node.textContent === label);
  const text = () => visible().map(node => node.textContent).join('\n');
  return { ui, state, calls, ids, find, text };
}

test('extension UI pending send/capture gates survive busy reset and callback bypass', async () => {
  const f = await fixture(intent({ tabId: 1, chatUrl: 'https://chatgpt.com/c/synthetic-chat', conversationId: 'synthetic-chat' }));
  const send = f.find('发送已阻断：缺原生绑定证明');
  const capture = f.find('采集已阻断：需原生绑定重核验');
  assert.ok(send); assert.ok(capture); assert.equal(send.disabled, true); assert.equal(capture.disabled, true);
  f.ui.setBusy(true); f.ui.setBusy(false);
  assert.equal(send.disabled, true); assert.equal(capture.disabled, true);
  // Calling a disabled listener directly still cannot generate a send command.
  await send.listeners.click();
  assert.equal(f.calls.some(call => call.op === 'send'), false);
});

test('extension UI requires dispatchValidated true in addition to ready verified binding', async () => {
  const f = await fixture(intent({ binding: { state: 'verified', conversationId: 'synthetic-chat' } }));
  assert.equal(f.find('发送已阻断：请重新核验绑定').disabled, true);
  f.state.intents[0].dispatchValidated = false; f.ui.render(f.state);
  assert.equal(f.find('发送已阻断：请重新核验绑定').disabled, true);
  f.state.intents[0].dispatchValidated = true; f.ui.render(f.state);
  assert.equal(f.find('审阅并确认发送一次').disabled, false);
  f.state.intents[0].state = 'unknown'; f.ui.render(f.state);
  assert.equal(f.find('审阅并确认发送一次'), undefined);
});

test('extension UI exposes explicit read-only binding/messages/idle operations without includeText', async () => {
  const f = await fixture();
  await f.find('检查原生绑定（只读）').listeners.click();
  await f.find('只读观察原生消息摘要').listeners.click();
  await f.find('检查 30 分钟空闲建议').listeners.click();
  for (const op of ['verifyBinding', 'observeMessages', 'idleCheck']) {
    const call = f.calls.find(value => value.op === op);
    assert.deepEqual(call, { op, id: 'synthetic-intent' });
  }
  assert.equal(f.calls.some(call => Object.hasOwn(call, 'includeText')), false);
  assert.equal(f.calls.some(call => call.op === 'send'), false);
});

test('extension UI evidence display excludes cross-task/conversation records and raw text', async () => {
  const f = await fixture(intent({ binding: { state: 'verified', conversationId: 'chat-a' }, messageEvidence: [
    { taskId: 'synthetic-intent', conversationId: 'chat-a', messageId: 'native-a', contentDigest: 'digest-a', source: 'native-host', sequence: 1, observedAt: 123, raw: 'DO-NOT-RENDER-RAW' },
    { taskId: 'other-task', conversationId: 'chat-a', summary: 'DO-NOT-RENDER-OTHER-TASK' },
    { taskId: 'synthetic-intent', conversationId: 'chat-b', summary: 'DO-NOT-RENDER-OTHER-CHAT' },
  ] }));
  const content = f.text();
  assert.match(content, /native-a/); assert.match(content, /digest-a/); assert.match(content, /native-host/);
  assert.doesNotMatch(content, /DO-NOT-RENDER/);
  assert.equal(source.includes('innerHTML'), false);
});

test('extension UI distinguishes native binding from user-confirmed URL and preserves idle advisory gate', async () => {
  const f = await fixture(intent({ binding: { state: 'verified', conversationId: 'chat-a' }, chatUrl: 'https://chatgpt.com/c/chat-a', dispatchValidated: true, lastIdleProposal: { status: 'blocked-unknown', nextSteps: ['Only read original owner status'], requiresUserConfirmation: true, autoSendAllowed: false } }));
  assert.match(f.text(), /chatUrl（原生身份已绑定；不代表业务完成）/);
  assert.match(f.text(), /Only read original owner status/);
  assert.match(f.text(), /autoSendAllowed: false/);
  assert.match(f.text(), /requires confirmation：是/);
  f.state.intents[0].binding = { state: 'pending' }; f.ui.render(f.state);
  assert.match(f.text(), /chatUrl（用户确认只读关联，未核验）/);
});

test('extension UI observation-only native recovery enables capture but never dispatch', async () => {
  const f = await fixture(intent({ tabId: 9, chatUrl: 'https://chatgpt.com/c/chat-a', conversationId: 'chat-a',
    binding: { state: 'verified', conversationId: 'chat-a' }, dispatchValidated: false,
    observationBinding: { conversationId: 'chat-a', tabId: 9, documentId: 'new-doc', dispatchAllowed: false }, observationValidated: true,
  }));
  assert.equal(f.find('发送已阻断：请重新核验绑定').disabled, true);
  assert.equal(f.find('采集所选原生 JSON（未核验）').disabled, false);
  f.ui.setBusy(true); f.ui.setBusy(false);
  assert.equal(f.find('发送已阻断：请重新核验绑定').disabled, true);
  assert.match(f.text(), /observationValidated true/);
  assert.match(f.text(), /dispatchAllowed: false/);
  f.state.intents[0].observationValidated = false; f.ui.render(f.state);
  assert.equal(f.find('采集已阻断：需原生绑定重核验').disabled, true);
});
