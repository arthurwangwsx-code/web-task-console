import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageProbe } from '../extension/page-probe.mjs';

function fixture() {
  let clicks=0,modal=false,occluded=false,inert=false,selectionIntersects=false;
  const style={visibility:'visible',opacity:'1',pointerEvents:'auto'};
  const form={tagName:'FORM'};
  const editor={innerText:'wire\nsecond',getClientRects:()=>[{}],getAttribute:k=>k==='aria-label'?'询问 ChatGPT':null,closest:q=>q==='form'?form:(inert?{}:null)};
  const button={disabled:false,getClientRects:()=>[{}],getAttribute:k=>k==='aria-label'?'发送':null,getBoundingClientRect:()=>({left:10,top:10,width:100,height:40}),contains:()=>false,closest:()=>inert?{}:null,click:()=>clicks++};
  form.querySelectorAll=()=>[button];
  const receiptElement={nodeType:1,closest:()=>null};
  const selection={toString:()=>'{"invocationId":"synthetic"}',rangeCount:1,getRangeAt:()=>({commonAncestorContainer:receiptElement,intersectsNode:()=>selectionIntersects})};
  const window={innerWidth:1000,innerHeight:800,getSelection:()=>selection};window.top=window;
  const document={querySelectorAll:q=>q.startsWith('[role="dialog"]')?(modal?[button]:[]):q.startsWith('[contenteditable')?[editor]:[form,editor],elementFromPoint:()=>occluded?{}:button};
  const context={window,document,location:{origin:'https://chatgpt.com',href:'https://chatgpt.com/'},URL,Node:{ELEMENT_NODE:1},getComputedStyle:()=>style,input:null};
  const run=input=>{context.input=input;return vm.runInNewContext(`(${pageProbe.toString()})(input)`,context)};
  return {run,context,editor,counts:()=>clicks,setModal:v=>modal=v,setOccluded:v=>occluded=v,setInert:v=>inert=v,setIntersection:v=>selectionIntersects=v};
}
test('page probe exact manually prepared multiline draft clicks once with no editing',()=>{
  const f=fixture();const r=f.run({op:'send',wirePrompt:'wire\nsecond',expectedUrl:'https://chatgpt.com/'});assert.equal(r.clickDispatched,true);assert.equal(f.counts(),1);assert.equal(f.editor.innerText,'wire\nsecond');assert.equal(r.ack,false);
});
test('page probe fails closed behind modal, occlusion or inert ancestry',()=>{
  for(const setter of ['setModal','setOccluded','setInert']){const f=fixture();f[setter](true);assert.throws(()=>f.run({op:'send',wirePrompt:'wire\nsecond'}),/UNAVAILABLE/);assert.equal(f.counts(),0);}
});
test('page probe checks navigation and does not return existing private draft',()=>{
  const f=fixture();f.editor.innerText='unrelated private draft';assert.throws(()=>f.run({op:'send',wirePrompt:'wire\nsecond'}),/NOT_EXACT/);assert.equal(f.counts(),0);
  const read=f.run({op:'inspect',wirePrompt:'wire\nsecond'});assert.equal(read.draftMatches,false);assert.doesNotMatch(JSON.stringify(read),/unrelated private draft/);
  assert.throws(()=>f.run({op:'send',expectedUrl:'https://chatgpt.com/c/other',wirePrompt:'wire\nsecond'}),/NAVIGATED/);
});
test('page capture rejects selections spanning any editable/form rather than only common ancestor',()=>{
  const f=fixture();assert.equal(f.run({op:'capture'}).selectedReceipt,'{"invocationId":"synthetic"}');f.setIntersection(true);
  assert.throws(()=>f.run({op:'capture'}),/INTERSECTS_DRAFT/);
});
test('page probe rejects credential-bearing URL userinfo before any page action',()=>{
  const f=fixture();f.context.location.href='https://synthetic-user:synthetic-pass@chatgpt.com/';
  assert.throws(()=>f.run({op:'send',wirePrompt:'wire\nsecond'}),error=>error.message==='UNAPPROVED_CHAT_PATH');assert.equal(f.counts(),0);
});
