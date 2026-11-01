import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityStatusObserver, mapCapabilityStatus } from '../src/capability-status-observer.mjs';
import { WorkspaceObserver } from '../src/workspace-observer.mjs';

const query = { invocationId:'inv_synthetic', idempotencyKey:'synthetic-key', source:'synthetic-approved-workspace', observedAt:'2026-01-01T00:00:03.000Z' };
function snapshot(overrides = {}) {
  return {
    structuredContent:{
      data:{id:'inv_synthetic',principalId:'local:synthetic-principal',capabilityId:'synthetic.system.status',providerId:'synthetic.system.control',status:'succeeded',
        queuedAt:'2026-01-01T00:00:00Z',startedAt:'2026-01-01T00:00:01Z',finishedAt:'2026-01-01T00:00:02Z',
        result:{privateSyntheticLabel:'do-not-persist-result',status:'succeeded',taskId:'not-a-business-receipt'},...overrides},
      meta:{requestId:'synthetic-status-read'},
    },
    content:[{type:'text',text:'Untrusted redundant text; must not be persisted or parsed.'}],
  };
}
test('capability succeeded maps only to router completed with exact invocation evidence',async()=>{
  const result=await mapCapabilityStatus(snapshot(),query);
  assert.equal(result.router.state,'completed');assert.equal(result.invocationId,query.invocationId);
  assert.equal(result.verified,false);assert.equal(result.provider,undefined);assert.equal(result.completion,undefined);
  assert.equal(result.callEvidence.requestId,'synthetic-status-read');
  assert.equal(result.callEvidence.requestedInvocationId,result.callEvidence.returnedInvocationId);
  assert.equal(result.callEvidence.authority,'router-only');
  assert.equal(result.callEvidence.chatIdentityVerified,false);assert.equal(result.callEvidence.businessVerified,false);
});
test('read-only adapter sends only invocationId exactly once, never key, invoke or retries',async()=>{
  const calls=[];const observer=new CapabilityStatusObserver({source:query.source,now:()=>Date.parse(query.observedAt),capabilityStatus:async args=>{calls.push(args);return snapshot()}});
  const result=await observer.observe({...query,invoke:()=>{throw new Error('must not execute')}});
  assert.deepEqual(calls,[{invocationId:query.invocationId}]);assert.equal(result.router.state,'completed');
  assert.equal(observer.readByKey,undefined);assert.equal(observer.invoke,undefined);
});
test('no invocationId means no read and no fabricated receipt or retry',async()=>{
  let calls=0;const observer=new CapabilityStatusObserver({source:query.source,capabilityStatus:async()=>{calls++;throw new Error('not called')}});
  assert.equal(await observer.observe({idempotencyKey:query.idempotencyKey}),null);
  assert.equal(await observer.observe({idempotencyKey:query.idempotencyKey,invocationId:null}),null);
  assert.equal(calls,0);
});
test('generic observer supports invocation-only lookup and does not invent readByKey',async()=>{
  const calls=[];
  const observer=new WorkspaceObserver({source:query.source,readByInvocation:async args=>{calls.push(args);return {source:query.source,idempotencyKey:query.idempotencyKey,invocationId:query.invocationId,observationId:'synthetic-read',observedAt:query.observedAt,router:{state:'completed'},verified:false}}});
  assert.equal(await observer.observe({idempotencyKey:query.idempotencyKey}),null);assert.equal(calls.length,0);
  const value=await observer.observe(query);assert.equal(calls.length,1);assert.equal(value.router.state,'completed');assert.equal(value.verified,false);
  assert.throws(()=>new WorkspaceObserver({source:query.source}),/read-only lookup/);
  assert.throws(()=>new WorkspaceObserver({source:query.source,readByInvocation:()=>{},readByKey:true}),/function/);
});
test('mismatched invocation and malformed structured results fail closed without text fallback',async()=>{
  await assert.rejects(mapCapabilityStatus(snapshot({id:'inv_different'}),query),/STATUS_INVOCATION_MISMATCH/);
  const missing=snapshot();delete missing.structuredContent.data.id;
  await assert.rejects(mapCapabilityStatus(missing,query),/STATUS_INVOCATION_FIELDS_REQUIRED/);
  await assert.rejects(mapCapabilityStatus({structuredContent:Object.create(snapshot().structuredContent)},query),/STATUS_STRUCTURED_DATA_REQUIRED/);
  for(const envelope of [{content:[{type:'text',text:JSON.stringify(snapshot().structuredContent)}]},{structuredContent:{data:[]}},snapshot({id:null})])
    await assert.rejects(mapCapabilityStatus(envelope,query));
  assert.equal(await mapCapabilityStatus({structuredContent:{data:null}},query),null);
  await assert.rejects(mapCapabilityStatus({...snapshot(),isError:true},query),/STATUS_TOOL_ERROR/);
});
test('lifecycle projection is conservative and unknown future states stay unknown',async()=>{
  for(const [status,state] of [['queued','queued'],['running','running'],['succeeded','completed'],['failed','failed'],['cancelled','canceled'],['canceled','canceled'],['future-success-state','unknown']]){
    const result=await mapCapabilityStatus(snapshot({status}),query);assert.equal(result.router.state,state);assert.equal(result.verified,false);assert.equal(result.provider,undefined);
  }
  const suspicious=['Bearer','synthetic-status-value'].join(' ');
  const unknown=await mapCapabilityStatus(snapshot({status:suspicious}),query);
  assert.equal(unknown.router.state,'unknown');assert.equal(unknown.callEvidence.status,'unrecognized');
  assert.doesNotMatch(JSON.stringify(unknown),/synthetic-status-value/);
});
test('principal, result, content, arbitrary metadata and forged completion never persist in projection',async()=>{
  const raw=snapshot({result:{authorization:'synthetic-sensitive-body',provider:{state:'succeeded',evidence:{authoritative:true}},businessVerified:true}});
  raw.structuredContent.meta.authorization='synthetic-sensitive-meta';
  raw._meta={'openai/subject':'synthetic-private-subject','openai/session':'synthetic-private-session'};
  raw.structuredContent.data.verified=true;
  const result=await mapCapabilityStatus(raw,query),restart=JSON.parse(JSON.stringify(result));
  const encoded=JSON.stringify(restart);
  for(const value of ['synthetic-sensitive-body','synthetic-sensitive-meta','synthetic-private-subject','synthetic-private-session','local:synthetic-principal','not-a-business-receipt','Untrusted redundant text'])assert.equal(encoded.includes(value),false);
  for(const key of ['principalDigest','resultDigest','snapshotDigest'])assert.match(restart.callEvidence[key],/^[a-f0-9]{64}$/);
  assert.equal(restart.verified,false);assert.equal(restart.provider,undefined);
});
test('projection digest is deterministic for JSON key order and changes when observed evidence changes',async()=>{
  const a=snapshot(),b=snapshot();b.structuredContent.data.result={taskId:'not-a-business-receipt',status:'succeeded',privateSyntheticLabel:'do-not-persist-result'};
  const x=await mapCapabilityStatus(a,query),y=await mapCapabilityStatus(b,query);
  assert.equal(x.observationId,y.observationId);assert.equal(x.callEvidence.snapshotDigest,y.callEvidence.snapshotDigest);
  b.structuredContent.data.result.status='running';
  const z=await mapCapabilityStatus(b,query);assert.notEqual(x.observationId,z.observationId);
});
test('timestamps and request IDs are validated; arbitrary text does not enter evidence identifiers',async()=>{
  await assert.rejects(mapCapabilityStatus(snapshot({finishedAt:'not a date'}),query),/STATUS_TIME_INVALID/);
  await assert.rejects(mapCapabilityStatus(snapshot({finishedAt:'2025-12-31T00:00:00Z'}),query),/STATUS_TIME_ORDER_INVALID/);
  for(const field of ['capabilityId','providerId'])await assert.rejects(mapCapabilityStatus(snapshot({[field]:'Bearer synthetic-secret'}),query),/STATUS_ROUTE_ID_INVALID/);
  const raw=snapshot();raw.structuredContent.meta.requestId='Bearer synthetic-secret';
  await assert.rejects(mapCapabilityStatus(raw,query),/STATUS_REQUEST_ID_INVALID/);
});
test('reader errors never echo upstream body and no failed read is automatically retried',async()=>{
  let calls=0;const observer=new CapabilityStatusObserver({source:query.source,capabilityStatus:async()=>{calls++;throw new Error(['Bearer','synthetic-do-not-echo'].join(' '))}});
  await assert.rejects(observer.observe(query),error=>error.message==='STATUS_READ_FAILED');assert.equal(calls,1);
});
test('invalid invocation input blocks before read, with constant safe errors',async()=>{
  let calls=0;const observer=new CapabilityStatusObserver({source:query.source,capabilityStatus:async()=>{calls++;return snapshot()}});
  for(const invocationId of ['',{},'Bearer synthetic-value','with/slash'])await assert.rejects(observer.observe({...query,invocationId}),error=>error.message==='STATUS_QUERY_ID_INVALID');
  assert.equal(calls,0);
});
test('hash projection is bounded and rejects non-JSON or deeply nested evidence',async()=>{
  let deep='synthetic';for(let n=0;n<66;n++)deep={nested:deep};
  await assert.rejects(mapCapabilityStatus(snapshot({result:deep}),query),/STATUS_SNAPSHOT_TOO_COMPLEX/);
  await assert.rejects(mapCapabilityStatus(snapshot({result:'x'.repeat(1048577)}),query),/STATUS_SNAPSHOT_TOO_LARGE/);
  const cycle={};cycle.self=cycle;
  await assert.rejects(mapCapabilityStatus(snapshot({result:cycle}),query),/STATUS_SNAPSHOT_NOT_JSON/);
});
