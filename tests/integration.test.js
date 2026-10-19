import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,hash,PRIVACY,FONTS} from '../core.js';
const clone=x=>structuredClone(x);
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
// Chrome storage can return dictionary keys in a different insertion order.
const stored=x=>Array.isArray(x)?x.map(stored):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stored(x[k])])):x;
function storage(){const values={};return {values,async get(keys){const out={};for(const k of typeof keys==='string'?[keys]:keys)if(k in values)out[k]=stored(values[k]);return out;},async set(v){Object.assign(values,stored(v));},async remove(keys){for(const k of typeof keys==='string'?[keys]:keys)delete values[k];},async setAccessLevel(){}};}
let serial=10,failCreate=false,failRemove=false,permissionGranted=true;
const tree=[{id:'0',children:[{id:'1',title:'Bookmarks bar',children:[]},{id:'2',title:'Other bookmarks',children:[]}]}];
function find(id,n=tree[0]){if(n.id===id)return n;for(const c of n.children||[]){const r=find(id,c);if(r)return r;}}
const bookmarks={getTree(cb){cb(clone(tree));},create(input,cb){if(failCreate){chrome.runtime.lastError={message:'模拟写入失败'};cb();delete chrome.runtime.lastError;return;}const n={...input,id:String(++serial),...(input.url===undefined?{children:[]}:{})};find(input.parentId).children.push(n);cb(clone(n));},removeTree(id,cb){if(failRemove){chrome.runtime.lastError={message:'模拟删除中断'};cb();delete chrome.runtime.lastError;return;}const remove=n=>{if(n.children){n.children=n.children.filter(c=>c.id!==id);n.children.forEach(remove);}};remove(tree[0]);cb();}};
for(const name of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded'])bookmarks[name]=event();
const alarms=new Map(),settings={},levels={},settingWrites=[];
globalThis.chrome={runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:event(),onInstalled:event(),onStartup:event(),openOptionsPage(){}},storage:{local:storage(),session:storage()},bookmarks,permissions:{async contains(){return permissionGranted;}},alarms:{onAlarm:event(),async create(name,options){alarms.set(name,options);},async clear(name){alarms.delete(name);}},action:{onClicked:event()},privacy:{network:{},services:{},websites:{}},fontSettings:{}};
for(const path of PRIVACY){const [a,b]=path.split('.');chrome.privacy[a][b]={get(o,cb){cb({value:settings[path],levelOfControl:levels[path]||'controllable_by_this_extension'});},set(o,cb){settingWrites.push(path);settings[path]=o.value;cb();},onChange:event()};}
for(const f of FONTS){chrome.fontSettings['get'+f]=(o,cb)=>cb({pixelSize:settings[f],levelOfControl:'controllable_by_this_extension'});chrome.fontSettings['set'+f]=(o,cb)=>{settings[f]=o.pixelSize;cb();};chrome.fontSettings['on'+f+'Changed']=event();}
let cloud=null,etag=0,conflict=false,methods=[],afterGet;
globalThis.fetch=async(url,o)=>{
  methods.push(o.method);
  if(o.method==='LOCK')return new Response(null,{status:405});
  if(o.method==='PROPFIND')return new Response('<multistatus/>',{status:207});
  if(o.method==='GET'){const result=cloud?new Response(JSON.stringify(cloud),{headers:{etag:'"'+etag+'"'}}):new Response('',{status:404});if(afterGet)await afterGet();return result;}
  assert.equal(o.method,'PUT');
  if(conflict||cloud&&o.headers['If-Match']!=='"'+etag+'"'||!cloud&&o.headers['If-None-Match']!=='*')return new Response('',{status:412});
  cloud=JSON.parse(o.body);etag++;return new Response(null,{status:201});
};
await import('../background.js');
const pass='integration-passphrase-123';
const config={url:'https://nas.example/sync/',username:'u',password:'p',pass,groups:['bookmarks'],interval:15,auto:false,remember:false,consent:true};
function message(action,rest={}){return new Promise(resolve=>chrome.runtime.onMessage.listeners[0]({action,...rest},{id:'test-id',url:chrome.runtime.getURL('options.html')},resolve));}
async function ok(action,rest){const r=await message(action,rest);assert.equal(r.ok,true,r.error);return r.data;}
const link=title=>({title,url:'https://example.com/'+title});
function localBookmark(title){find('1').children=[{id:String(++serial),...link(title)}];find('2').children=[];}
function doc(title,time=Date.now()-10000){return {version:1,groups:{bookmarks:{time,device:'remote',data:{bar:[link(title)],other:[],mobile:[]}}}};}
const titles=()=>find('1').children.map(n=>n.title);
beforeEach(async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  for(const store of Object.values(chrome.storage))for(const k of Object.keys(store.values))delete store.values[k];
  serial=10;failCreate=false;failRemove=false;permissionGranted=true;cloud=null;etag=0;conflict=false;methods=[];afterGet=undefined;alarms.clear();
  for(const p of PRIVACY){settings[p]=true;delete levels[p];}for(const f of FONTS)settings[f]=16;settingWrites.length=0;
  tree[0].children=tree[0].children.filter(n=>['1','2'].includes(n.id));localBookmark('local');await ok('save',{config});
});
test('First sync requires an explicit direction; diagnostics and obsolete merge action cannot write',async()=>{
  const before=clone(tree);await ok('save',{config:{...config,auto:true}});
  assert.equal(alarms.has('periodic'),false);
  await chrome.alarms.onAlarm.listeners[0]({name:'periodic'});assert.deepEqual(methods,[]);
  assert.match((await message('sync')).error,/先选择/);assert.deepEqual(methods,[]);
  assert.match((await message('mergeBookmarks')).error,/不支持/);
  assert.match(await ok('diagnose',{config}),/HTTP 207/);assert.deepEqual(methods,['PROPFIND']);assert.deepEqual(tree,before);
  await ok('upload');assert.equal(alarms.get('periodic').periodInMinutes,15);
  alarms.clear();await chrome.runtime.onStartup.listeners[0]();assert.equal(alarms.get('periodic').periodInMinutes,15);
});
test('Upload replaces even newer cloud bookmarks, preserves local data and unselected cloud categories, and backs up old cloud',async()=>{
  const remote=doc('cloud-only',Date.now()+60000);remote.groups.privacy={time:1,device:'other',data:{'services.searchSuggestEnabled':false}};
  cloud=await encrypt(remote,pass);etag++;
  const before=clone(tree);failCreate=true;failRemove=true;
  await ok('upload');
  const uploaded=await decrypt(cloud,pass);
  assert.deepEqual(uploaded.groups.bookmarks.data.bar,[link('local')]);assert.ok(uploaded.groups.bookmarks.time>remote.groups.bookmarks.time);
  assert.deepEqual(uploaded.groups.privacy,remote.groups.privacy);assert.deepEqual(tree,before);
  const b=chrome.storage.local.values.backups[0];assert.match(b.reason,/覆盖云端/);assert.deepEqual(Object.keys(b.data),['bookmarks']);assert.deepEqual(b.data.bookmarks.bar,[link('cloud-only')]);
  assert.equal(chrome.storage.local.values.journal,undefined);
});
test('Download replaces newer local bookmarks and selected settings with an older cloud snapshot; it only sends GET',async()=>{
  const remote=doc('cloud-authority',1);remote.groups.privacy={time:1,device:'remote',data:{'services.searchSuggestEnabled':false}};remote.groups.fonts={time:1,device:'remote',data:{DefaultFontSize:20}};
  cloud=await encrypt(remote,pass);etag++;
  await ok('save',{config:{...config,groups:['bookmarks','privacy','fonts']}});
  const original=clone(cloud);await ok('download');
  assert.deepEqual(titles(),['cloud-authority']);assert.equal(settings['services.searchSuggestEnabled'],false);assert.equal(settings.DefaultFontSize,20);
  assert.deepEqual(cloud,original);assert.deepEqual(methods,['GET']);
  const b=chrome.storage.local.values.backups[0];assert.match(b.reason,/覆盖本机/);assert.deepEqual(b.data.bookmarks.bar,[link('local')]);assert.equal(b.data.privacy['services.searchSuggestEnabled'],true);assert.equal(b.data.fonts.DefaultFontSize,16);
  assert.equal(chrome.storage.local.values.state.records.bookmarks.time,1);
  assert.equal(chrome.storage.local.values.journal,undefined);
  const backupCount=chrome.storage.local.values.backups.length;
  await ok('sync');assert.deepEqual(methods,['GET','GET']);assert.deepEqual(cloud,original);assert.equal(chrome.storage.local.values.backups.length,backupCount);
});
test('Legacy bookmark snapshots without a mobile key represent an empty mobile folder',async()=>{
  tree[0].children.push({id:'3',title:'Mobile bookmarks',children:[{id:String(++serial),...link('mobile-local')}]});
  const remote=doc('remote');delete remote.groups.bookmarks.data.mobile;cloud=await encrypt(remote,pass);etag++;
  const original=clone(cloud);await ok('download');assert.deepEqual(titles(),['remote']);assert.deepEqual(find('3').children,[]);assert.deepEqual(cloud,original);assert.deepEqual(methods,['GET']);
  assert.deepEqual(chrome.storage.local.values.backups[0].data.bookmarks.mobile,[link('mobile-local')]);
});
test('Missing cloud file or selected category aborts the whole download without initializing, writing or applying anything',async()=>{
  const before=clone(tree);assert.match((await message('download')).error,/云端缺少/);assert.deepEqual(methods,['GET']);assert.deepEqual(tree,before);assert.equal(chrome.storage.local.values.state.initialized?.bookmarks,undefined);
  cloud=await encrypt(doc('remote'),pass);etag++;
  await ok('save',{config:{...config,groups:['bookmarks','fonts']}});methods=[];const original=clone(cloud);
  assert.match((await message('download')).error,/字号/);assert.deepEqual(tree,before);assert.deepEqual(cloud,original);assert.deepEqual(methods,['GET']);assert.equal(chrome.storage.local.values.backups,undefined);
});
test('Both manual directions reject the wrong key or invalid document before any overwrite',async()=>{
  cloud=await encrypt(doc('remote'),pass);etag++;const original=clone(cloud),before=clone(tree);
  await ok('save',{config:{...config,pass:'wrong-independent-pass'}});
  for(const action of ['upload','download'])assert.match((await message(action)).error,/解密失败/);
  assert.deepEqual(tree,before);assert.deepEqual(cloud,original);assert.ok(!methods.includes('PUT'));assert.equal(chrome.storage.local.values.backups,undefined);
  await ok('save',{config});cloud=await encrypt({version:1,groups:{bookmarks:{time:1,device:'x',data:{bar:[{title:'bad',url:'bad'}],other:[]}}}},pass);
  for(const action of ['upload','download'])assert.match((await message(action)).error,/网址无效/);
  assert.deepEqual(tree,before);assert.ok(!methods.includes('PUT'));
});
test('Conflict, failed backup and concurrent local edits stop manual writes without changing either side',async()=>{
  cloud=await encrypt(doc('remote'),pass);etag++;const original=clone(cloud),before=clone(tree);conflict=true;
  assert.match((await message('upload')).error,/HTTP 412/);assert.deepEqual(cloud,original);assert.deepEqual(tree,before);assert.equal(chrome.storage.local.values.journal,undefined);conflict=false;
  const set=chrome.storage.local.set;
  try{chrome.storage.local.set=async v=>{if(v.backups)throw Error('备份空间不足');return set(v);};
    for(const action of ['upload','download'])assert.match((await message(action)).error,/空间不足/);
  }finally{chrome.storage.local.set=set;}
  assert.deepEqual(cloud,original);assert.deepEqual(tree,before);
  afterGet=async()=>{localBookmark('concurrent');bookmarks.onChanged.listeners.forEach(fn=>fn());};
  assert.match((await message('upload')).error,/发生变化/);assert.deepEqual(cloud,original);assert.deepEqual(titles(),['concurrent']);
});
test('Initialized automatic sync uploads local edits and downloads newer cloud data and deletions without combining entries',async()=>{
  await ok('save',{config:{...config,auto:true}});await ok('upload');
  localBookmark('edited');await chrome.alarms.onAlarm.listeners[0]({name:'changed'});
  assert.deepEqual((await decrypt(cloud,pass)).groups.bookmarks.data.bar,[link('edited')]);
  cloud=await encrypt(doc('remote-newer',Date.now()+1000),pass);etag++;
  await chrome.alarms.onAlarm.listeners[0]({name:'periodic'});assert.deepEqual(titles(),['remote-newer']);
  const empty=doc('unused',Date.now()+2000);empty.groups.bookmarks.data.bar=[];cloud=await encrypt(empty,pass);etag++;
  const before=clone(cloud);await ok('sync');assert.deepEqual(titles(),[]);assert.deepEqual(cloud,before);
  await ok('save',{config:{...config,auto:true,groups:['bookmarks','fonts']}});assert.equal(alarms.has('periodic'),false);
  assert.match((await message('sync')).error,/先选择/);
});
test('Legacy order-sensitive hashes do not promote unchanged local data above a newer cloud snapshot',async()=>{
  const data={bar:[link('local')],other:[],mobile:[]};
  const legacyHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)))).toString('base64');
  chrome.storage.local.values.state={device:'legacy',initialized:{bookmarks:true},records:{bookmarks:{data,time:1,device:'legacy',hash:legacyHash}}};
  cloud=await encrypt(doc('newer-cloud'),pass);etag++;await ok('sync');
  assert.deepEqual(titles(),['newer-cloud']);assert.ok(!methods.includes('PUT'));
});
test('Creation and deletion failures keep a recovery point visible and block every sync direction until restored',async()=>{
  cloud=await encrypt(doc('remote'),pass);etag++;const original=clone(cloud);failCreate=true;
  assert.match((await message('download')).error,/模拟写入失败/);assert.deepEqual(titles(),['local']);failCreate=false;
  const point=chrome.storage.local.values.journal.backupId;
  assert.ok((await ok('load')).backups.some(b=>b.id===point));
  for(const action of ['upload','download','sync'])assert.match((await message(action)).error,/中断/);
  await ok('restore',{id:point});assert.equal(chrome.storage.local.values.journal,undefined);assert.equal(chrome.storage.local.values.config.auto,false);
  failRemove=true;assert.match((await message('download')).error,/模拟删除中断/);failRemove=false;
  await ok('restore',{id:chrome.storage.local.values.journal.backupId});assert.deepEqual(titles(),['local']);assert.deepEqual(cloud,original);
});
test('Keep-current recovery preserves additions and backups, pauses automation, and requires an explicit next direction',async()=>{
  const recovery={id:'recovery',time:1,reason:'云端覆盖前自动备份',data:{bookmarks:{bar:[link('local')],other:[],mobile:[]}}};
  chrome.storage.local.values.backups=Array.from({length:4},(_,i)=>({...clone(recovery),id:'later-'+i})).concat([recovery]);
  chrome.storage.local.values.journal={backupId:recovery.id,time:2};chrome.storage.local.values.config.auto=true;
  chrome.storage.local.values.state={device:'local',initialized:{bookmarks:true,privacy:true},records:{privacy:{data:{},time:1,device:'local'}}};
  find('1').children.push({id:String(++serial),...link('addition')});const before=clone(tree);
  await ok('keepCurrentBookmarks',{id:recovery.id});assert.deepEqual(tree,before);assert.deepEqual(methods,[]);
  const {backups,journal,state,config:saved}=chrome.storage.local.values;
  assert.equal(journal,undefined);assert.equal(saved.auto,false);assert.equal(backups.length,5);assert.ok(backups.some(b=>b.id===recovery.id));assert.match(backups[0].reason,/解除中断前/);
  assert.equal(state.initialized.bookmarks,false);assert.equal(state.initialized.privacy,true);assert.equal(state.records.privacy.time,1);assert.equal(state.records.bookmarks.hash,await hash(backups[0].data.bookmarks));
  assert.match((await message('sync')).error,/先选择/);cloud=await encrypt(doc('remote-only'),pass);etag++;await ok('upload');
  assert.deepEqual((await decrypt(cloud,pass)).groups.bookmarks.data.bar,[link('local'),link('addition')]);assert.deepEqual(tree,before);
});
test('Keep-current recovery rejects missing, duplicate, moved and mixed content, failed backups and concurrent edits',async()=>{
  const point={id:'guarded',time:1,reason:'test',data:{bookmarks:{bar:[link('missing')],other:[],mobile:[]}}};
  chrome.storage.local.values.backups=[clone(point)];chrome.storage.local.values.journal={backupId:point.id};const before=clone(tree);
  assert.match((await message('keepCurrentBookmarks',{id:'wrong'})).error,/恢复点已变化/);
  assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/缺少恢复点/);
  const b=chrome.storage.local.values.backups[0];b.data={bookmarks:{bar:[link('local')],other:[],mobile:[]},fonts:{DefaultFontSize:16}};
  assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/不只包含收藏夹/);delete b.data.fonts;
  b.data.bookmarks.bar.push(link('local'));assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/缺少恢复点/);b.data.bookmarks.bar.pop();
  b.data.bookmarks.other.push({title:'Empty folder',children:[]});assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/缺少恢复点/);b.data.bookmarks.other=[];
  const set=chrome.storage.local.set;
  try{chrome.storage.local.set=async v=>{if(v.backups)throw Error('备份空间不足');return set(v);};assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/空间不足/);}finally{chrome.storage.local.set=set;}
  assert.deepEqual(tree,before);assert.deepEqual(methods,[]);assert.equal(chrome.storage.local.values.journal.backupId,point.id);
  try{chrome.storage.local.set=async v=>{await set(v);if(v.backups){localBookmark('concurrent-edit');bookmarks.onChanged.listeners.forEach(fn=>fn());}};assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/发生变化/);}finally{chrome.storage.local.set=set;}
  assert.equal(chrome.storage.local.values.journal.backupId,point.id);
});
test('Clearing the key, missing permissions and account changes retain protections for manual and automatic sync',async()=>{
  await ok('upload');await ok('clearPass');assert.equal(chrome.storage.session.values.pass,undefined);assert.equal(chrome.storage.local.values.config.auto,false);
  for(const action of ['upload','download','sync'])assert.match((await message(action)).error,/加密口令/);
  await ok('save',{config});permissionGranted=false;
  for(const action of ['upload','download','sync'])assert.match((await message(action)).error,/站点权限缺失/);permissionGranted=true;
  await ok('save',{config:{...config,username:'different',auto:true}});assert.match((await message('sync')).error,/先选择/);assert.equal(alarms.has('periodic'),false);
});

test('Password-manager-owned matching preferences do not block bookmark downloads or take ownership',async()=>{
  const locked=['services.autofillAddressEnabled','services.autofillCreditCardEnabled','services.passwordSavingEnabled'];
  for(const k of locked){settings[k]=false;levels[k]='controlled_by_other_extensions';}
  const remote=doc('cloud-bookmark');remote.groups.privacy={time:1,device:'remote',data:Object.fromEntries(PRIVACY.map(k=>[k,settings[k]]))};
  remote.groups.privacy.data['services.searchSuggestEnabled']=false;
  cloud=await encrypt(remote,pass);etag++;await ok('save',{config:{...config,groups:['bookmarks','privacy']}});
  const original=clone(cloud);await ok('download');assert.deepEqual(titles(),['cloud-bookmark']);assert.deepEqual(cloud,original);
  assert.deepEqual(settingWrites,['services.searchSuggestEnabled']);assert.equal(chrome.storage.local.values.journal,undefined);
  for(const k of locked){assert.equal(settings[k],false);assert.equal(levels[k],'controlled_by_other_extensions');}
  const next=clone(remote);next.groups.bookmarks.data.bar=[link('must-not-apply')];next.groups.privacy.data[locked[0]]=true;cloud=await encrypt(next,pass);etag++;
  assert.match((await message('download')).error,/地址自动填充.*当前值与目标不同/);assert.deepEqual(titles(),['cloud-bookmark']);assert.equal(chrome.storage.local.values.journal,undefined);
  assert.ok(!methods.includes('PUT'));
});
