import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let round=0;
async function setup(){
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const previous={chrome:globalThis.chrome,document:globalThis.document,confirm:globalThis.confirm};
  const elements=new Map(),requests=[],messages=[],prompts=[];
  let config={url:'https://nas.example/sync/',username:'test',password:'',groups:['bookmarks'],interval:15,auto:false,remember:false,consent:true},backups=[],journal,status,allowConfirm=true,fail=false;
  const node=tag=>({tag,value:'',checked:false,children:[],events:{},addEventListener(event,fn){this.events[event]=fn;},replaceChildren(){this.children=[];},append(...children){this.children.push(...children);}});
  const element=id=>{if(!elements.has(id))elements.set(id,node('element'));return elements.get(id);};
  globalThis.document={getElementById:element,querySelectorAll:()=>[],createElement:node};
  globalThis.confirm=prompt=>{prompts.push(prompt);return allowConfirm;};
  globalThis.chrome={permissions:{async request(request){for(const permission of request.permissions||[])assert.ok(manifest.optional_permissions.includes(permission),'Permission cannot be requested as optional: '+permission);requests.push(request);return true;}},runtime:{async sendMessage(m){
    messages.push(m);
    if(m.action==='load')return {ok:true,data:{config,hasPass:true,backups,journal,status}};
    if(m.action==='save'){config=m.config;return {ok:true};}
    if(['upload','download','sync'].includes(m.action)){
      if(fail){backups=[{id:'point',time:1,reason:'覆盖本机前自动备份'}];journal={backupId:'point'};status={message:'模拟应用中断',time:Date.now()};return {ok:false,error:status.message};}
      status={message:m.action+' success',time:Date.now()};return {ok:true};
    }
    throw Error('Unexpected action: '+m.action);
  }}};
  await import('../options.js?test='+(++round));await new Promise(resolve=>setImmediate(resolve));
  return {manifest,element,requests,messages,prompts,get config(){return config;},set allowConfirm(v){allowConfirm=v;},set fail(v){fail=v;},close(){Object.assign(globalThis,previous);}};
}
test('Saving font sync only requests declared optional permissions and preserves selected groups',async()=>{
  const f=await setup();try{
    assert.ok(f.manifest.permissions.includes('fontSettings'));assert.ok(!f.manifest.optional_permissions.includes('fontSettings'));
    f.element('fonts').checked=true;await f.element('config').onsubmit({preventDefault(){}});
    assert.deepEqual(f.requests[0],{origins:['https://nas.example/*'],permissions:[]});assert.deepEqual(f.config.groups,['bookmarks','fonts']);
    f.element('privacy').checked=true;await f.element('config').onsubmit({preventDefault(){}});
    assert.deepEqual(f.requests[1],{origins:['https://nas.example/*'],permissions:['privacy']});assert.deepEqual(f.config.groups,['bookmarks','privacy','fonts']);
  }finally{f.close();}
});
test('Overwrite buttons send their chosen direction, allow cancellation and block unsaved configuration',async()=>{
  const f=await setup();try{
    await f.element('upload').onclick();await f.element('download').onclick();
    assert.deepEqual(f.messages.filter(m=>m.action!=='load').map(m=>m.action),['upload','download']);
    assert.match(f.prompts[0],/本机.*覆盖云端/);assert.match(f.prompts[1],/云端.*覆盖本机/);
    const before=f.messages.length;f.allowConfirm=false;await f.element('upload').onclick();assert.equal(f.messages.length,before);
    f.allowConfirm=true;f.element('config').events.input();
    for(const action of ['upload','download','sync'])await f.element(action).onclick();
    assert.deepEqual(f.messages.filter(m=>m.action!=='load').map(m=>m.action),['upload','download']);assert.match(f.element('status').textContent,/先点击.*保存配置/);
  }finally{f.close();}
});
test('An application failure immediately refreshes the recovery point and its backup in the UI',async()=>{
  const f=await setup();try{
    f.fail=true;await f.element('download').onclick();
    assert.equal(f.element('recovery').hidden,false);assert.match(f.element('status').textContent,/模拟应用中断/);
    const point=f.element('backups').children[0];assert.ok(point);
    assert.match(point.children[0].textContent,/覆盖本机前自动备份.*中断恢复点/);
    assert.ok(point.children.some(c=>c.textContent==='保留当前收藏夹并解除中断'));
  }finally{f.close();}
});
