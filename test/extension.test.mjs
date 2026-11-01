import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExtensionController, extractReceipt, limits } from '../extension/controller.mjs';
import { ChromeHost } from '../extension/chrome-host.mjs';
import { pageProbe } from '../extension/page-probe.mjs';
import { verifyDispatchBinding } from '../extension/task-binding.mjs';
import { safeErrorCode } from '../extension/errors.mjs';

async function fixture() {
  let data, now = 10000, seq = 0, clicks = 0, opens = 0, permission = true;
  const store = {read:async()=>structuredClone(data),write:async v=>{data=structuredClone(v)}};
  const tabs = new Map();
  const host = {
    hasPermission:async()=>permission,
    async open(url) { const tab={tabId:++opens,url,documentId:`doc-${opens}`,draftMatches:true};tabs.set(opens,tab);return {tabId:opens,url}; },
    async inspect(tab, prompt, bind) {const actual=tabs.get(tab.tabId);if(!actual)throw new Error('gone');if(!bind&&actual.documentId!==tab.documentId)throw new Error('DOCUMENT_CHANGED');return {...actual,composerCount:1,sendButtonCount:1,sendEnabled:true,conversationId:actual.url==="https://chatgpt.com/"?null:actual.url.split('/c/')[1],ack:false};},
    async verifyIdentity(tab, context) {const actual=tabs.get(tab.tabId);return {available:true,source:'native-host',accountContextId:actual.accountContextId??'synthetic-account',conversationId:actual.url.split('/c/')[1],url:actual.url,documentId:actual.documentId,tabId:tab.tabId,browserSessionId:context.browserSessionId,reference:'synthetic-native-only'};},
    async dispatchVerified(tab, wirePrompt, binding) {
      const actual=tabs.get(tab.tabId),context={tabId:tab.tabId,url:actual.url,documentId:actual.documentId,browserSessionId:binding.browserSessionId};
      const intent={id:binding.taskId,idempotencyKey:binding.idempotencyKey,prompt:controller.get(binding.taskId).prompt,wirePrompt};
      await verifyDispatchBinding(intent,binding,await this.verifyIdentity(tab,context),context);
      clicks++;return {url:actual.url,documentId:actual.documentId,clickDispatched:true,ack:false};
    },
    async capture(tab) {return {...await this.inspect(tab,'',false),selectedReceipt:JSON.stringify({invocationId:'synthetic-invocation',status:'completed'})};},
    async rebindReadOnly(tab, expectedUrl, wirePrompt) {if(tabs.get(tab.tabId).url!==expectedUrl)throw new Error('URL_MISMATCH');return this.inspect(tab,wirePrompt,true);},
  };
  const controller=await new ExtensionController({store,host,sessionId:'browser-session',uuid:()=>`id-${++seq}`,now:()=>now}).init();
  const bind=async i=>{const actual=tabs.get(controller.get(i.id).tabId);actual.url='https://chatgpt.com/c/synthetic-conversation'+(actual.tabId===1?'':'-'+actual.tabId);return controller.verifyBinding({id:i.id});};
  return {controller,store,host,tabs,bind,advance:(ms=60001)=>{now+=ms},counts:()=>({clicks,opens}),permission:v=>{permission=v},data:()=>data};
}
const create = (f,key='synthetic-key')=>f.controller.create({idempotencyKey:key,prompt:'@WorkSpace synthetic\nsecond line'});
const opened=async f=>{const i=await create(f);await f.controller.open({id:i.id});await f.bind(i);return i;};

test('extension no permission means no tabs; enqueue itself never sends',async()=>{
  const f=await fixture();const i=await create(f);f.permission(false);
  await assert.rejects(f.controller.open({id:i.id}),/PERMISSION/);assert.deepEqual(f.counts(),{clicks:0,opens:0});
});
test('extension prototype-like keys are ordinary deduped keys',async()=>{
  const f=await fixture();for(const key of ['constructor','__proto__','toString']){const a=await create(f,key);assert.equal((await create(f,key)).id,a.id)}
  assert.equal(f.controller.snapshot().intents.length,3);
  await assert.rejects(f.controller.create({idempotencyKey:'constructor',prompt:'changed'}),/CONFLICT/);
});
test('extension concurrent confirmed sends click exactly once then remain unknown',async()=>{
  const f=await fixture();const i=await opened(f);
  const results=await Promise.allSettled([f.controller.send({id:i.id,confirmed:true}),f.controller.send({id:i.id,confirmed:true})]);
  assert.equal(results[0].value.state,'unknown');assert.equal(results[1].status,'rejected');assert.equal(f.counts().clicks,1);
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);
  assert.equal(f.controller.snapshot().intents[0].provider.verified,false);
});
test('extension never replaces a wrong/shared draft and requires explicit send confirmation',async()=>{
  const f=await fixture();const i=await opened(f);f.tabs.get(1).draftMatches=false;
  await assert.rejects(f.controller.send({id:i.id}),/CONFIRMATION/);
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/PASTE_EXACT/);
  assert.equal(f.counts().clicks,0);assert.equal(f.controller.snapshot().intents[0].state,'ready');
});
test('extension reload/document drift blocks send with no new binding',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.inspect({id:i.id});f.advance();f.tabs.get(1).documentId='refreshed';
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/DOCUMENT_CHANGED/);assert.equal(f.counts().clicks,0);
});
test('extension pending durable send survives worker restart as unknown without retry',async()=>{
  const f=await fixture();const i=await opened(f);const state=f.data();state.intents[0].state='sending';state.intents[0].attempts=1;await f.store.write(state);
  const recovered=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.equal(recovered.snapshot().intents[0].state,'unknown');await assert.rejects(recovered.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);assert.equal(f.counts().clicks,0);
});
test('browser restart detaches old tab identities instead of touching reused tab ids',async()=>{
  const f=await fixture();const i=await opened(f);
  const recovered=await new ExtensionController({store:f.store,host:f.host,sessionId:'new-browser-session'}).init();
  await assert.rejects(recovered.inspect({id:i.id}),/OWNED_TAB_NOT_AVAILABLE/);assert.equal(recovered.snapshot().ownedTabs[0].status,'detached-after-browser-restart');
});
test('native JSON capture keeps raw data but never resolves unknown or business authority',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  await f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true});
  const result=await f.controller.capture({id:i.id,confirmed:true});assert.equal(result.state,'unknown');assert.equal(result.provider.verified,false);
  assert.equal(result.nativeReceipts[0].refs.invocationId,'synthetic-invocation');assert.equal(result.nativeReceipts[0].verified,false);assert.equal(result.nativeReceipts[0].provenance,'external-observed');
  await f.controller.capture({id:i.id,confirmed:true});assert.equal(f.controller.snapshot().intents[0].nativeReceipts.length,1);
});
test('first same-document conversation candidate cannot silently bind an unrelated receipt',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});f.advance();
  // Model a migrated legacy attempt with no native binding; observation is not proof.
  Object.assign(f.controller.get(i.id),{conversationId:null,binding:{state:'pending'}});
  Object.assign(f.controller.state.ownedTabs[0],{conversationId:null,url:'https://chatgpt.com/'});
  await f.controller.inspect({id:i.id});
  const state=f.controller.snapshot().intents[0];assert.equal(state.conversationId,null);assert.equal(state.observedChatUrl,'https://chatgpt.com/c/synthetic-conversation');
  await assert.rejects(f.controller.capture({id:i.id,confirmed:true}),/CONFIRM_TASK_CONVERSATION/);
});
test('explicit read-only restore after refresh never restores send authority',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});f.tabs.get(1).documentId='refreshed';
  await f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true});
  assert.equal(f.controller.snapshot().ownedTabs[0].documentId,'refreshed');assert.equal(f.controller.snapshot().intents[0].state,'unknown');
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);assert.equal(f.counts().clicks,1);
  await assert.rejects(f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/other',confirmed:true}),/CONFLICT/);
});
test('explicit read-only browser restart recovery creates a new owned tab, never reuses stale id',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'new-browser-session'}).init();
  await restarted.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true});
  assert.equal(restarted.snapshot().intents[0].tabId,2);assert.equal(f.counts().opens,2);assert.equal(f.counts().clicks,1);
  assert.equal(restarted.snapshot().ownedTabs[1].readOnly,true);
});
test('receipt capture rejects credentials, mismatched keys, prose, missing and contradictory IDs',()=>{
  const i={idempotencyKey:'k'};
  for(const value of ['done',JSON.stringify({status:'completed'}),JSON.stringify({invocationId:'x',authorization:'secret'}),JSON.stringify({invocationId:'x',idempotencyKey:'other'}),JSON.stringify({invocationId:'x',result:{invocationId:'y'}})])assert.throws(()=>extractReceipt(value,i,{}));
  const raw=JSON.stringify({invocationId:'x',provider:{runId:'r',sessionId:'s'},idempotencyKey:'k'});const r=extractReceipt(raw,i,{});assert.equal(r.refs.runId,'r');assert.equal(r.refs.sessionId,'s');assert.equal(r.raw,raw);assert.equal(r.verified,false);
});
test('decoded credential guard rejects escaped keys and nested array/object keys without echo',()=>{
  const cases = [
    JSON.stringify({invocationId:'synthetic',authorization:'synthetic-test-only'}).replace('"authorization"','"\\u0061uthorization"'),
    JSON.stringify({invocationId:'synthetic',result:{items:[{access_token:'synthetic-test-only'}]}}).replace('access_token','access\\u005ftoken'),
    JSON.stringify({invocationId:'synthetic',result:[{headers:{Authorization:'synthetic-test-only'}}]}).replace('Authorization','Authori\\u007aation'),
    JSON.stringify({invocationId:'synthetic',nested:{client_secret:'synthetic-test-only'}}).replace('client_secret','client\\u005fsecret'),
  ];
  for(const raw of cases)assert.throws(()=>extractReceipt(raw,{idempotencyKey:'k'},{}),error=>error.message==='CREDENTIAL_LIKE_RECEIPT_REJECTED');
});
test('decoded string values and overwritten duplicate JSON fields cannot hide credential shapes',()=>{
  const cases = [
    JSON.stringify({invocationId:'synthetic',nested:[{note:['Bearer','synthetic-test-only'].join(' ')}]}).replace('Bearer','\\u0042earer'),
    '{"invocationId":"synthetic","note":"\\u0042earer synthetic-test-only","note":"safe replacement"}',
    JSON.stringify({invocationId:'synthetic',note:['Basic','c3ludGhldGljLW9ubHk='].join(' ')}).replace('Basic','\\u0042asic'),
  ];
  for(const raw of cases)assert.throws(()=>extractReceipt(raw,{idempotencyKey:'k'},{}),error=>error.message==='CREDENTIAL_LIKE_RECEIPT_REJECTED');
});
test('decoded credential guard permits legitimate escaped/nested receipt data and preserves raw',()=>{
  const raw=JSON.stringify({invocationId:'synthetic-invocation',idempotencyKey:'k',provider:{runId:'synthetic-run',sessionId:'synthetic-session'},result:{items:[{label:'synthetic',tokenCount:12,authorizationRequired:false,state:'completed'}]}}).replace('"synthetic"','"\\u5408\\u6210\\u56de\\u6267"');
  const parsed=extractReceipt(raw,{idempotencyKey:'k'},{});assert.equal(parsed.raw,raw);assert.equal(parsed.refs.runId,'synthetic-run');assert.equal(parsed.verified,false);
});
test('rejected escaped credential capture never persists across restart or deletes prior valid receipts',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  await f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true});
  await f.controller.capture({id:i.id,confirmed:true});
  const prior=structuredClone(f.data());
  f.host.capture=async tab=>({...await f.host.inspect(tab,'',false),selectedReceipt:JSON.stringify({invocationId:'synthetic',items:[{access_token:'synthetic-do-not-persist'}]}).replace('access_token','access\\u005ftoken')});
  await assert.rejects(f.controller.capture({id:i.id,confirmed:true}),error=>error.message==='CREDENTIAL_LIKE_RECEIPT_REJECTED');
  assert.deepEqual(f.data(),prior);assert.doesNotMatch(JSON.stringify(f.data()),/synthetic-do-not-persist/);
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.equal(restarted.snapshot().intents[0].nativeReceipts.length,1);assert.equal(restarted.snapshot().intents[0].state,'unknown');
  assert.deepEqual(restarted.snapshot().intents[0].nativeReceipts,prior.intents[0].nativeReceipts);
});
test('receipt guard bounds deeply nested decoded structures without stack overflow',()=>{
  let nested='safe';for(let n=0;n<70;n++)nested={item:nested};
  assert.throws(()=>extractReceipt(JSON.stringify({invocationId:'synthetic',nested}),{idempotencyKey:'k'},{}),/STRUCTURE_TOO_COMPLEX/);
});
test('Chrome host refuses username/password URLs before any Chrome tab API call',async()=>{
  let calls=0;const host=new ChromeHost({permissions:{contains:async()=>true},tabs:{create:async()=>{calls++;return{id:1}},get:async()=>{calls++;return{id:1}}}});
  for(const url of ['https://synthetic-user@chatgpt.com/c/synthetic','https://:synthetic-pass@chatgpt.com/c/synthetic','https://synthetic-user:synthetic-pass@chatgpt.com/','https://synthetic%40user@chatgpt.com/c/synthetic']){
    await assert.rejects(host.open(url),error=>error.message==='UNAPPROVED_CHAT_URL');
    await assert.rejects(host.rebindReadOnly({tabId:1},url,'wire'),error=>error.message==='UNAPPROVED_CHAT_URL');
  }
  assert.equal(calls,0);
});
test('controller rejects URL userinfo before restore side effects and keeps it out of restart data',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});const prior=structuredClone(f.data());
  await assert.rejects(f.controller.restore({id:i.id,chatUrl:'https://synthetic-user:synthetic-pass@chatgpt.com/c/synthetic-conversation',confirmed:true}),error=>error.message==='EXACT_CHAT_URL_REQUIRED');
  assert.deepEqual(f.data(),prior);assert.equal(f.counts().opens,1);
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.doesNotMatch(JSON.stringify(restarted.snapshot()),/synthetic-pass|synthetic-user/);
  assert.equal(restarted.snapshot().intents[0].state,'unknown');
});
test('extension queue, active unknown and tab budgets fail closed',async()=>{
  const f=await fixture();for(let n=0;n<limits.maxQueued;n++)await create(f,`key-${n}`);await assert.rejects(create(f,'overflow'),/QUEUE_FULL/);
  const g=await fixture();for(let n=0;n<3;n++){const i=await create(g,`active-${n}`);await g.controller.open({id:i.id});await g.bind(i);if(n<2)await g.controller.send({id:i.id,confirmed:true});else await assert.rejects(g.controller.send({id:i.id,confirmed:true}),/CAPACITY/)}assert.equal(g.counts().clicks,2);
});
test('extension failed durable reservation causes no browser click',async()=>{
  const f=await fixture();const i=await opened(f);f.store.write=async()=>{throw new Error('storage quota')};await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/storage quota/);assert.equal(f.counts().clicks,0);
});
test('failed create budget uses a candidate and leaves no ghost intent or poisoned pause/cancel',async()=>{
  const f=await fixture();const old=await create(f,'existing');
  f.controller.state.syntheticPadding='';
  const bytes=new TextEncoder().encode(JSON.stringify(f.controller.state)).length;
  f.controller.state.syntheticPadding='x'.repeat(limits.maxStorageBytes-bytes-128);
  await f.controller.save();const before=structuredClone(f.controller.snapshot());
  await assert.rejects(create(f,'overflow-budget'),/LOCAL_STORAGE_BUDGET/);
  assert.deepEqual(f.controller.snapshot(),before);assert.equal(f.controller.snapshot().intents.length,1);
  await f.controller.pause({paused:true});await f.controller.cancel({id:old.id});
  assert.equal(f.controller.snapshot().paused,true);assert.equal(f.controller.snapshot().intents[0].state,'canceled');
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.equal(restarted.snapshot().intents.length,1);assert.equal(restarted.snapshot().intents[0].state,'canceled');
});
test('local create storage failure leaves old snapshot unchanged and safe retry remains local',async()=>{
  const f=await fixture();const before=f.controller.snapshot();const write=f.store.write;
  f.store.write=async()=>{throw new Error('synthetic storage failure')};
  await assert.rejects(create(f),/storage failure/);assert.deepEqual(f.controller.snapshot(),before);
  f.store.write=write;await create(f);await f.controller.pause({paused:true});
  assert.equal(f.controller.snapshot().intents.length,1);assert.deepEqual(f.counts(),{clicks:0,opens:0});
});
test('failed local receipt save does not keep a ghost receipt or alter unrelated local state',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  await f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true});
  const before=f.controller.snapshot(), write=f.store.write;f.store.write=async()=>{throw new Error('synthetic storage failure')};
  await assert.rejects(f.controller.capture({id:i.id,confirmed:true}),/storage failure/);assert.deepEqual(f.controller.snapshot(),before);
  f.store.write=write;await f.controller.pause({paused:true});assert.equal(f.controller.snapshot().intents[0].nativeReceipts.length,0);
});
test('post-click persistence failure never rolls back unknown or permits another external send',async()=>{
  const f=await fixture();const i=await opened(f),write=f.store.write;
  f.store.write=async state=>{if(state.intents[0].state==='unknown')throw new Error('post-click save failure');return write(state)};
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/post-click save failure/);
  assert.equal(f.counts().clicks,1);assert.equal(f.controller.snapshot().intents[0].state,'unknown');assert.equal(f.data().intents[0].state,'sending');
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);
  f.store.write=write;const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.equal(restarted.snapshot().intents[0].state,'unknown');await assert.rejects(restarted.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);assert.equal(f.counts().clicks,1);
});
test('extension pause and removed owned tabs never cancel remote business work',async()=>{
  const f=await fixture();const i=await opened(f);await f.controller.pause({paused:true});await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/PAUSED/);
  await f.controller.removed(1);assert.equal(f.controller.snapshot().intents[0].state,'unknown');await assert.rejects(f.controller.cancel({id:i.id}),/ONLY_UNSENT/);assert.equal(f.counts().clicks,0);
});
test('Chrome host uses isolated world and exact documentId, never all frames',async()=>{
  let injected;const api={permissions:{contains:async()=>true},tabs:{get:async()=>({id:7,url:'https://chatgpt.com/'})},scripting:{executeScript:async args=>{injected=args;return [{frameId:0,documentId:'doc',result:{url:'https://chatgpt.com/'}}]}}};
  const host=new ChromeHost(api);await host.inspect({tabId:7,documentId:'doc',url:'https://chatgpt.com/'},'wire');
  assert.deepEqual(injected.target,{tabId:7,documentIds:['doc']});assert.equal(injected.world,'ISOLATED');assert.equal(injected.func,pageProbe);
  await assert.rejects(host.send(),/ATOMIC_NATIVE_DISPATCH_UNAVAILABLE/);
  await assert.rejects(host.dispatchVerified(),/ATOMIC_NATIVE_DISPATCH_UNAVAILABLE/);
  api.tabs.get=async()=>({id:7,url:'https://unapproved.example/'});await assert.rejects(host.inspect({tabId:7,documentId:'doc'},'wire'),/ORIGIN_CHANGED/);
});
test('extension manifest has only narrow declared permissions and no external bridges',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.permissions,['storage','scripting']);assert.deepEqual(manifest.optional_host_permissions,['https://chatgpt.com/*']);
  for(const name of ['host_permissions','content_scripts','externally_connectable','web_accessible_resources'])assert.equal(manifest[name],undefined);
  assert.match(manifest.content_security_policy.extension_pages,/connect-src 'none'/);
  const source=await readFile(new URL('../extension/background.mjs',import.meta.url),'utf8');assert.match(source,/sender\.url !== chrome\.runtime\.getURL\('console.html'\)/);
  assert.match(source,/TRUSTED_CONTEXTS/);assert.doesNotMatch(source,/onMessageExternal|cookies|webRequest|debugger|nativeMessaging/);
});

test('production ChromeHost has no send path without native identity contract',async()=>{
  let calls=0;const host=new ChromeHost({scripting:{executeScript:async()=>{calls++}}});
  assert.equal((await host.verifyIdentity()).available,false);
  for(const action of [()=>host.send(),()=>host.dispatchVerified(),()=>host.execute({}, {op:'send'})])
    await assert.rejects(action(),/ATOMIC_NATIVE_DISPATCH_UNAVAILABLE/);
  assert.equal(calls,0);
});
test('pending binding or unavailable native identity cannot dispatch from page claims',async()=>{
  const f=await fixture();const i=await create(f);await f.controller.open({id:i.id});
  f.host.verifyIdentity=async()=>({available:false});
  const result=await f.controller.verifyBinding({id:i.id,proof:{available:true,source:'native-host'}});
  assert.equal(result.binding.state,'pending');assert.equal(result.bindingCheck.available,false);
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/NATIVE_BINDING_VERIFICATION_REQUIRED/);
  assert.equal(f.counts().clicks,0);assert.equal(f.controller.get(i.id).attempts,0);
});
test('concurrent native binding proposals cannot claim one conversation twice',async()=>{
  const f=await fixture(),a=await create(f,'a'),b=await create(f,'b');
  await f.controller.open({id:a.id});await f.controller.open({id:b.id});
  for(const tab of f.tabs.values())tab.url='https://chatgpt.com/c/synthetic-shared';
  const results=await Promise.allSettled([f.controller.verifyBinding({id:a.id}),f.controller.verifyBinding({id:b.id})]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  assert.match(results[1].reason.message,/CONVERSATION_IN_USE/);
  assert.equal(f.controller.get(b.id).binding.state,'pending');assert.equal(f.counts().clicks,0);
});
test('duplicate binding is idempotent but immutable identity refuses conversation replacement',async()=>{
  const f=await fixture(),i=await opened(f),before=structuredClone(f.controller.get(i.id).binding);
  await f.controller.verifyBinding({id:i.id});assert.deepEqual(f.controller.get(i.id).binding,before);
  f.tabs.get(1).url='https://chatgpt.com/c/synthetic-other';
  await assert.rejects(f.controller.verifyBinding({id:i.id}),/IMMUTABLE/);
  assert.deepEqual(f.controller.get(i.id).binding,before);
});
test('wrong conversation and native account changes block before any send attempt',async()=>{
  const f=await fixture(),i=await opened(f);
  f.tabs.get(1).url='https://chatgpt.com/c/synthetic-other';
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/CONVERSATION_CHANGED/);
  f.tabs.get(1).url='https://chatgpt.com/c/synthetic-conversation';f.tabs.get(1).accountContextId='synthetic-other-account';f.advance();
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/BINDING_CONTEXT_CHANGED/);
  assert.equal(f.counts().clicks,0);assert.equal(f.controller.get(i.id).attempts,0);
});
test('edited original goal fails digest verification even with unchanged exact draft',async()=>{
  const f=await fixture(),i=await opened(f);f.controller.get(i.id).prompt='different synthetic goal';
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/BINDING_TASK_CHANGED/);assert.equal(f.counts().clicks,0);
});
test('navigation at atomic dispatch boundary yields unknown and never clicks or retries',async()=>{
  const f=await fixture(),i=await opened(f),dispatch=f.host.dispatchVerified;
  f.host.dispatchVerified=async(...args)=>{f.tabs.get(1).url='https://chatgpt.com/c/synthetic-race';return dispatch.apply(f.host,args)};
  const result=await f.controller.send({id:i.id,confirmed:true});
  assert.equal(result.state,'unknown');assert.equal(result.attempts,1);assert.equal(f.counts().clicks,0);
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);
});
test('worker restart never trusts persisted send authority even when document still exists',async()=>{
  const f=await fixture(),i=await opened(f);
  const recovered=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.equal(recovered.get(i.id).dispatchValidated,false);
  await assert.rejects(recovered.send({id:i.id,confirmed:true}),/NATIVE_BINDING_VERIFICATION_REQUIRED/);
  await recovered.verifyBinding({id:i.id});assert.equal(recovered.get(i.id).dispatchValidated,true);assert.equal(f.counts().clicks,0);
});
const nativeMessage=(f,i,extra={})=>{const b=f.controller.get(i.id).binding;return {source:'native-host',tabId:b.tabId,documentId:b.documentId,browserSessionId:b.browserSessionId,accountContextId:b.accountContextId,conversationId:b.conversationId,messageId:'synthetic-message',kind:'assistant',observedAt:20000,truncated:false,raw:'synthetic reply',...extra};};
test('post-dispatch native user ACK is message transport evidence, never business completion',async()=>{
  const f=await fixture(),i=await opened(f),dispatch=f.host.dispatchVerified;
  f.host.dispatchVerified=async(...args)=>({...await dispatch.apply(f.host,args),messageEvidence:nativeMessage(f,i,{kind:'user',raw:f.controller.get(i.id).wirePrompt})});
  const result=await f.controller.send({id:i.id,confirmed:true});
  assert.equal(result.state,'sent');assert.equal(result.transport.state,'acknowledged');
  assert.equal(result.provider.state,'unknown');assert.equal(result.provider.verified,false);
  assert.equal(result.messageEvidence[0].raw,undefined);assert.equal(result.messageEvidence[0].businessState,'unknown');
});
test('native reply observation rejects cross-conversation pollution without partial persistence',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});const before=structuredClone(f.data());
  f.host.observeMessages=async()=>[nativeMessage(f,i),nativeMessage(f,i,{messageId:'second',conversationId:'wrong-conversation'})];
  await assert.rejects(f.controller.observeMessages({id:i.id}),/MESSAGE_CONTEXT_MISMATCH/);
  assert.deepEqual(f.data(),before);assert.equal(f.controller.get(i.id).messageEvidence.length,0);
});
test('native reply observations preserve bounded same-chat provenance and dedup across restart',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  f.host.observeMessages=async()=>[nativeMessage(f,i,{truncated:true})];
  await f.controller.observeMessages({id:i.id});await f.controller.observeMessages({id:i.id});
  const first=f.controller.get(i.id).messageEvidence[0];assert.equal(first.raw,undefined);assert.equal(first.truncated,true);assert.equal(first.source,'native-host');
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.equal(restarted.get(i.id).messageEvidence.length,1);assert.equal(restarted.get(i.id).provider.state,'unknown');
});
test('credential-shaped post-click evidence cannot leak through browserObservation or restart',async()=>{
  const f=await fixture(),i=await opened(f),dispatch=f.host.dispatchVerified;
  const secret=JSON.stringify({nested:{access_token:'synthetic-sensitive-value'}}).replace('access_token','access\\u005ftoken');
  f.host.dispatchVerified=async(...args)=>({...await dispatch.apply(f.host,args),messageEvidence:nativeMessage(f,i,{raw:secret,includeText:true})});
  const result=await f.controller.send({id:i.id,confirmed:true});assert.equal(result.state,'unknown');assert.equal(result.messageEvidence.length,0);
  assert.doesNotMatch(JSON.stringify(f.data()),/synthetic-sensitive-value/);
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.doesNotMatch(JSON.stringify(restarted.snapshot()),/synthetic-sensitive-value/);assert.equal(f.counts().clicks,1);
});
test('idle checks are local, auditable, deduplicated and never continue an unknown task',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  const early=await f.controller.idleCheck({id:i.id});assert.equal(early.idleCheck.status,'not-due');
  f.advance(30*60*1000);const due=await f.controller.idleCheck({id:i.id}),size=due.audit.length;
  assert.equal(due.lastIdleProposal.status,'blocked-unknown');assert.equal(due.lastIdleProposal.autoSendAllowed,false);
  assert.match(due.lastIdleProposal.draft,/@WorkSpace synthetic/);
  f.advance();await f.controller.idleCheck({id:i.id});assert.equal(f.controller.get(i.id).audit.length,size);assert.equal(f.counts().clicks,1);
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session',now:()=>2000000}).init();
  assert.equal(restarted.get(i.id).lastIdleProposal.suggestionId,due.lastIdleProposal.suggestionId);
});
test('host exceptions never persist or expose arbitrary credential-bearing error messages',async()=>{
  const secret=['upstream failed:','Bearer','synthetic-sensitive-error-value'].join(' ');
  assert.equal(safeErrorCode(new Error(secret)),'OPERATION_FAILED');
  const f=await fixture(),i=await opened(f);
  f.host.dispatchVerified=async()=>{throw new Error(secret)};
  const result=await f.controller.send({id:i.id,confirmed:true});
  assert.equal(result.error,'OPERATION_FAILED');assert.doesNotMatch(JSON.stringify(f.data()),/synthetic-sensitive-error-value/);
  const g=await fixture(),j=await opened(g);g.host.inspect=async()=>{throw new Error(secret)};
  await assert.rejects(g.controller.inspect({id:j.id}),error=>error.message==='OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(g.data()),/synthetic-sensitive-error-value/);
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'browser-session'}).init();
  assert.doesNotMatch(JSON.stringify(restarted.snapshot()),/synthetic-sensitive-error-value/);
});
test('failed readonly restore commit leaves no ghost document or later pause contamination',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  const before=f.controller.snapshot(),write=f.store.write;f.tabs.get(1).documentId='refreshed-document';
  f.store.write=async()=>{throw new Error('synthetic storage failure')};
  await assert.rejects(f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true}),/storage failure/);
  assert.deepEqual(f.controller.snapshot(),before);
  f.store.write=write;await f.controller.pause({paused:true});
  assert.equal(f.data().ownedTabs[0].documentId,'doc-1');assert.equal(f.data().intents[0].observationBinding,undefined);
});
test('failed local inspect commit never poisons in-memory state or subsequent mutations',async()=>{
  const f=await fixture(),i=await opened(f),before=f.controller.snapshot(),write=f.store.write;
  f.store.write=async()=>{throw new Error('synthetic storage failure')};
  await assert.rejects(f.controller.inspect({id:i.id}),/storage failure/);assert.deepEqual(f.controller.snapshot(),before);
  f.store.write=write;await f.controller.pause({paused:true});assert.equal(f.data().intents[0].browserObservation,undefined);
});
test('refresh readonly native rebind permits observations but never modifies immutable dispatch binding',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  const original=structuredClone(f.controller.get(i.id).binding);f.tabs.get(1).documentId='refreshed-document';
  await f.controller.restore({id:i.id,chatUrl:original.canonicalUrl,confirmed:true});
  const restored=f.controller.get(i.id);
  assert.deepEqual(restored.binding,original);assert.equal(restored.dispatchValidated,false);assert.equal(restored.observationBinding.dispatchAllowed,false);
  await f.controller.capture({id:i.id,confirmed:true});
  f.host.observeMessages=async(tab,binding)=>[nativeMessage(f,i,{documentId:binding.documentId,messageId:'after-refresh'})];
  await f.controller.observeMessages({id:i.id});
  assert.equal(f.controller.get(i.id).messageEvidence[0].documentId,'refreshed-document');
  await assert.rejects(f.controller.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);assert.equal(f.counts().clicks,1);
});
test('browser restart readonly native rebind restores observation only in new owned context',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  const original=structuredClone(f.controller.get(i.id).binding);
  const restarted=await new ExtensionController({store:f.store,host:f.host,sessionId:'new-browser-session'}).init();
  await restarted.restore({id:i.id,chatUrl:original.canonicalUrl,confirmed:true});
  f.host.observeMessages=async(tab,binding)=>[{...nativeMessage(f,i),tabId:binding.tabId,documentId:binding.documentId,browserSessionId:binding.browserSessionId}];
  await restarted.observeMessages({id:i.id});await restarted.capture({id:i.id,confirmed:true});
  assert.deepEqual(restarted.get(i.id).binding,original);assert.equal(restarted.get(i.id).messageEvidence[0].tabId,2);
  await assert.rejects(restarted.send({id:i.id,confirmed:true}),/ALREADY_ATTEMPTED/);assert.equal(f.counts().clicks,1);
});
test('readonly recovery refuses changed native account even when user confirms same URL',async()=>{
  const f=await fixture(),i=await opened(f);await f.controller.send({id:i.id,confirmed:true});
  const before=f.controller.snapshot();f.tabs.get(1).documentId='new-doc';f.tabs.get(1).accountContextId='different-native-account';
  await assert.rejects(f.controller.restore({id:i.id,chatUrl:'https://chatgpt.com/c/synthetic-conversation',confirmed:true}),/OBSERVATION_IDENTITY_CHANGED/);
  assert.deepEqual(f.controller.snapshot(),before);assert.equal(f.counts().clicks,1);
});
