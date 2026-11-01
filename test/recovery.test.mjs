import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentEngine } from '../src/engine.mjs';
import { MemoryStore, JsonStore } from '../src/store.mjs';
import { DemoAdapter } from '../src/demo-adapter.mjs';
import { WorkspaceObserver } from '../src/workspace-observer.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function setup() {
  let now = 10000;
  const adapter = await new DemoAdapter(new MemoryStore()).open();
  const engine = await new IntentEngine({store: new MemoryStore(), adapter, clock:()=>now, config:{minDispatchIntervalMs:0}}).open();
  const i = await engine.enqueue({idempotencyKey:'recover-key',prompt:'synthetic'}); await engine.tick();
  return {engine,adapter,i,advance:()=>{now+=100000;}};
}
test('full disk restart preserves lost ACK, exact key and one synthetic provider send', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'intent-restart-'));
  let runtime;
  try {
    runtime = await createRuntime({dataDir}); runtime.adapter.setScenario('lost-ack');
    const i = await runtime.engine.enqueue({idempotencyKey:'disk-key',prompt:'one\ntwo'}); await runtime.engine.tick();
    await runtime.close(); runtime = await createRuntime({dataDir});
    assert.equal(runtime.engine.snapshot().intents[0].status,'unknown');
    assert.equal((await runtime.engine.enqueue({idempotencyKey:'disk-key',prompt:'one\ntwo'})).id,i.id);
    await runtime.engine.tick(); assert.equal(runtime.adapter.state.sends,1);
    assert.equal((await runtime.engine.reconcile(i.id)).status,'succeeded');
  } finally {await runtime?.close();await rm(dataDir,{recursive:true,force:true});}
});
test('running evidence is never reused to prove a later unevidenced terminal observation', async () => {
  const {engine,adapter,i,advance}=await setup(); let n=0;
  const observer=new WorkspaceObserver({source:'owner',readByKey:async()=>({idempotencyKey:i.idempotencyKey,invocationId:'inv-1',observationId:`obs-${++n}`,observedAt:`2026-01-01T00:00:0${n}Z`,source:'owner',verified:true,router:{state:'completed'},provider:{taskId:'task-1',state:n===1?'running':'succeeded',...(n===1?{evidence:{authoritative:true,source:'owner',reference:'running-evidence'}}:{})}})});
  adapter.observe=x=>observer.observe(x);
  assert.equal((await engine.reconcile(i.id)).completion.verified,false); advance();
  const second=await engine.reconcile(i.id); assert.equal(second.provider.state,'succeeded');assert.equal(second.completion.verified,false);
  await assert.rejects(engine.closeTab(second.tabId),/PROTECTED/);
});
test('stale observations and contradictory receipt identifiers fail closed', async () => {
  const {engine,adapter,i,advance}=await setup(); let n=0;
  adapter.observe=async()=>({idempotencyKey:i.idempotencyKey,invocationId:'inv',observationId:`o-${++n}`,observedAt:n===1?'2026-01-02T00:00:00Z':'2026-01-01T00:00:00Z',source:'owner',verified:true,router:{state:'running'},provider:{state:'running',taskId:'task'}});
  await engine.reconcile(i.id);advance();const stale=await engine.reconcile(i.id); assert.match(stale.poll.error,/STALE/);assert.equal(stale.observationIds.length,1);
  advance();adapter.observe=async()=>({idempotencyKey:i.idempotencyKey,invocationId:'other-inv',observationId:'o-new',observedAt:'2026-01-03T00:00:00Z',source:'owner',verified:true,router:{state:'completed'}});
  assert.match((await engine.reconcile(i.id)).poll.error,/INVOCATION_ID_CONFLICT/);
});
test('uncertain close never repeats a close command without a readback', async () => {
  const {engine,adapter,i}=await setup();await engine.reconcile(i.id);let closes=0;
  adapter.safeClose=async()=>{closes++;throw new Error('close ack lost')};
  assert.equal((await engine.closeTab(`tab-${i.id}`)).state,'close-unknown');
  await assert.rejects(engine.closeTab(`tab-${i.id}`),/REQUIRES_READBACK/);assert.equal(closes,1);
});
test('a failed durable reservation prevents any external send', async () => {
  const store=new MemoryStore();const adapter=await new DemoAdapter(new MemoryStore()).open();
  const engine=await new IntentEngine({store,adapter}).open();await engine.enqueue({idempotencyKey:'store-fail',prompt:'synthetic'});
  store.save=async()=>{throw new Error('disk full')};await assert.rejects(engine.tick(),/disk full/);assert.equal(adapter.state.sends,0);
});

test('legacy unknown prototype-key intents remain protected; absence never triggers replay', async () => {
  const store = new MemoryStore();
  const adapter = await new DemoAdapter(new MemoryStore({version:1,jobs:{},tabs:{},sends:0})).open();
  const engine = await new IntentEngine({store,adapter}).open();
  const created = await engine.enqueue({idempotencyKey:'constructor',prompt:'synthetic legacy'});
  store.value.intents[0].dispatch = {state:'unknown',attempts:1};
  const restarted = await new IntentEngine({store,adapter}).open();
  await restarted.tick();
  const observed = await restarted.reconcile(created.id);
  assert.equal(observed.status,'unknown');
  assert.equal(observed.completion.verified,false);
  assert.equal(adapter.state.sends,0);
  assert.equal(restarted.snapshot().metrics.active,1);
});
