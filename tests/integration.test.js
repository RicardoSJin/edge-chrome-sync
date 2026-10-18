import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,hash} from '../core.js';
const clone=x=>structuredClone(x);
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
// Chrome storage can return dictionary keys in a different insertion order.
const stored=x=>Array.isArray(x)?x.map(stored):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stored(x[k])])):x;
function storage(){const values={};return {values,async get(keys){const out={};for(const k of typeof keys==='string'?[keys]:keys)if(k in values)out[k]=stored(values[k]);return out;},async set(v){Object.assign(values,stored(v));},async remove(keys){for(const k of typeof keys==='string'?[keys]:keys)delete values[k];},async setAccessLevel(){}};}
let serial=10,failCreate=false,failRemove=false;
const tree=[{id:'0',children:[{id:'1',title:'Bookmarks bar',children:[]},{id:'2',title:'Other bookmarks',children:[]}]}];
function find(id,n=tree[0]) {if(n.id===id)return n;for(const child of n.children||[]){const result=find(id,child);if(result)return result;}}
const bookmarks={getTree(cb){cb(clone(tree));},create(input,cb){if(failCreate){chrome.runtime.lastError={message:'模拟写入失败'};cb();delete chrome.runtime.lastError;return;}const n={...input,id:String(++serial),...(input.url===undefined?{children:[]}:{})};find(input.parentId).children.push(n);cb(clone(n));},removeTree(id,cb){if(failRemove){chrome.runtime.lastError={message:'模拟删除中断'};cb();delete chrome.runtime.lastError;return;}const search=n=>{if(n.children){n.children=n.children.filter(c=>c.id!==id);n.children.forEach(search);}};search(tree[0]);cb();}};
for(const name of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded'])bookmarks[name]=event();
let permissionGranted=true;
globalThis.chrome={runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:event(),onInstalled:event(),onStartup:event(),openOptionsPage(){}},storage:{local:storage(),session:storage()},bookmarks,permissions:{async contains(){return permissionGranted;}},alarms:{onAlarm:event(),async create(){},async clear(){}},action:{onClicked:event()}};
let cloud=null,etag=0,conflict=false,putCount=0,requestCount=0;
globalThis.fetch=async(url,o)=>{
  requestCount++;
  if(o.method==='LOCK')return new Response(null,{status:405});
  if(o.method==='PROPFIND')return new Response('<multistatus/>',{status:207});
  if(o.method==='GET')return cloud?new Response(JSON.stringify(cloud),{headers:{etag:'"'+etag+'"'}}):new Response('',{status:404});
  putCount++;
  if(conflict||cloud&&o.headers['If-Match']!=='"'+etag+'"'||!cloud&&o.headers['If-None-Match']!=='*')return new Response('',{status:412});
  cloud=JSON.parse(o.body);etag++;return new Response(null,{status:201});
};
await import('../background.js');
const pass='integration-passphrase-123';
const config={url:'https://nas.example/sync/',username:'u',password:'p',pass,groups:['bookmarks'],interval:15,auto:false,remember:false,consent:true};
function message(action,rest={}){return new Promise(resolve=>chrome.runtime.onMessage.listeners[0]({action,...rest},{id:'test-id',url:chrome.runtime.getURL('options.html')},resolve));}
async function ok(action,rest){const r=await message(action,rest);assert.equal(r.ok,true,r.error);return r.data;}
function localBookmark(title){find('1').children=[{id:String(++serial),title,url:'https://example.com/'+title}];}
function doc(title,time=Date.now()-10000){return {version:1,groups:{bookmarks:{time,device:'remote',data:{bar:[{title,url:'https://example.com/'+title}],other:[],mobile:[]}}}};}
test('End-to-end worker: initial upload/download, edits, key failure, conflict, backup, recovery, lock',async()=>{
  const treeBefore=clone(tree);
  assert.match(await ok('diagnose',{config}),/HTTP 207/);
  assert.equal(chrome.storage.local.values.config,undefined);assert.equal(chrome.storage.session.values.pass,undefined);assert.equal(putCount,0);assert.deepEqual(tree,treeBefore);
  localBookmark('initial');await ok('save',{config});await ok('sync');assert.equal((await decrypt(cloud,pass)).groups.bookmarks.data.bar[0].title,'initial');
  assert.equal(chrome.storage.local.values.pass,undefined);assert.equal(chrome.storage.session.values.pass,pass);
  const macState=clone(chrome.storage.local.values.state),macTree=clone(tree);
  // A second client with more/different bookmarks must preserve both copies.
  chrome.storage.local.values.state={};localBookmark('second-client');await ok('sync');
  assert.deepEqual(find('1').children.map(n=>n.title),['initial','second-client']);assert.equal(chrome.storage.local.values.backups.length,1);
  assert.deepEqual(chrome.storage.local.values.backups[0].data.bookmarks.bar.map(n=>n.title),['second-client']);
  assert.match(chrome.storage.local.values.backups[0].reason,/合并/);
  assert.deepEqual((await decrypt(cloud,pass)).groups.bookmarks.data.bar.map(n=>n.title),['initial','second-client']);
  const windowsState=clone(chrome.storage.local.values.state),windowsTree=clone(tree);
  chrome.storage.local.values.state=macState;tree.splice(0,tree.length,...clone(macTree));await ok('sync');
  assert.deepEqual(find('1').children.map(n=>n.title),['initial','second-client']);
  // Normal sync after initialization must propagate deletion, not resurrect it.
  localBookmark('initial');await ok('sync');chrome.storage.local.values.state=windowsState;tree.splice(0,tree.length,...clone(windowsTree));await ok('sync');
  assert.deepEqual(find('1').children.map(n=>n.title),['initial']);
  // Explicit merge also works after initialization, including after restoring a
  // pre-overwrite backup from an older release. It does not touch settings.
  const beforeManual=await decrypt(cloud,pass);beforeManual.groups.privacy={time:1,device:'other',data:{'services.searchSuggestEnabled':false}};
  cloud=await encrypt(beforeManual,pass);etag++;
  localBookmark('second-client');await ok('mergeBookmarks');
  const manual=await decrypt(cloud,pass);assert.deepEqual(manual.groups.bookmarks.data.bar.map(n=>n.title),['initial','second-client']);
  assert.deepEqual(manual.groups.privacy,{time:1,device:'other',data:{'services.searchSuggestEnabled':false}});
  assert.match(chrome.storage.local.values.status.message,/合并/);
  const preMergeBackup=chrome.storage.local.values.backups[0].id;
  await ok('restore',{id:preMergeBackup});assert.deepEqual(find('1').children.map(n=>n.title),['second-client']);
  await ok('mergeBookmarks');assert.deepEqual(find('1').children.map(n=>n.title),['initial','second-client']);
  const beforeFailedMerge=clone(cloud);localBookmark('unsynced');conflict=true;
  assert.equal((await message('mergeBookmarks')).ok,false);assert.deepEqual(cloud,beforeFailedMerge);
  assert.deepEqual(find('1').children.map(n=>n.title),['unsynced']);assert.equal(chrome.storage.local.values.journal,undefined);conflict=false;
  localBookmark('edited');await ok('sync');assert.equal((await decrypt(cloud,pass)).groups.bookmarks.data.bar[0].title,'edited');
  const oldCloud=clone(cloud);localBookmark('conflicting');conflict=true;const c=await message('sync');assert.equal(c.ok,false);assert.deepEqual(cloud,oldCloud);assert.equal(find('1').children[0].title,'conflicting');conflict=false;
  await ok('save',{config:{...config,pass:'wrong-independent-pass'}});const before=putCount;assert.equal((await message('sync')).ok,false);assert.equal(putCount,before);assert.equal(find('1').children[0].title,'conflicting');
  await ok('save',{config});chrome.storage.local.values.state={};cloud=await encrypt(doc('remote'),pass);etag++;
  failCreate=true;const failed=await message('sync');assert.equal(failed.ok,false);assert.equal(find('1').children[0].title,'conflicting');assert.ok(chrome.storage.local.values.journal);failCreate=false;
  assert.match((await message('sync')).error,/中断/);
  const recoveryId=chrome.storage.local.values.journal.backupId;await ok('restore',{id:recoveryId});assert.equal(chrome.storage.local.values.journal,undefined);assert.equal(find('1').children[0].title,'conflicting');
  // Failed deletion keeps a recoverable journal and a full original backup.
  chrome.storage.local.values.state={};failRemove=true;assert.equal((await message('sync')).ok,false);assert.ok(chrome.storage.local.values.journal);failRemove=false;await ok('restore',{id:chrome.storage.local.values.journal.backupId});
  assert.equal(find('1').children.length,1);assert.equal(find('1').children[0].title,'conflicting');
  await ok('clearPass');assert.equal(chrome.storage.session.values.pass,undefined);assert.equal(chrome.storage.local.values.config.auto,false);assert.match((await message('sync')).error,/加密口令/);
  assert.match(await ok('diagnose',{config}),/HTTP 207/);
  permissionGranted=false;assert.match((await message('sync')).error,/站点权限缺失/);assert.match((await message('diagnose',{config})).error,/站点权限缺失/);permissionGranted=true;
});

test('Legacy hashes cannot promote unchanged local data over a newer cloud snapshot',async()=>{
  await ok('save',{config});localBookmark('unchanged');
  const data={bar:[{title:'unchanged',url:'https://example.com/unchanged'}],other:[],mobile:[]};
  const legacyHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)))).toString('base64');
  chrome.storage.local.values.state={device:'legacy',initialized:{bookmarks:true},records:{bookmarks:{data,time:1,device:'legacy',hash:legacyHash}}};
  cloud=await encrypt(doc('newer-cloud'),pass);etag++;
  const beforePut=putCount;await ok('sync');
  assert.equal(find('1').children[0].title,'newer-cloud');
  assert.equal((await decrypt(cloud,pass)).groups.bookmarks.device,'remote');
  assert.equal(putCount,beforePut);
});

test('Keep-current recovery preserves additions, pins backups, pauses sync and forces the next merge',async()=>{
  localBookmark('original');
  find('1').children.push({id:String(++serial),title:'Folder',children:[{id:String(++serial),title:'Nested',url:'https://example.com/nested'}]});
  const data={bookmarks:{bar:[{title:'original',url:'https://example.com/original'},{title:'Folder',children:[{title:'Nested',url:'https://example.com/nested'}]}],mobile:[],other:[]}};
  const recovery={id:'recovery',time:1,reason:'云端覆盖前自动备份',data};
  chrome.storage.local.values.backups=Array.from({length:4},(_,i)=>({...clone(recovery),id:'later-'+i})).concat([recovery]);
  chrome.storage.local.values.journal={backupId:recovery.id,time:2};
  chrome.storage.local.values.config={...config,auto:true};
  chrome.storage.local.values.state={device:'local',initialized:{bookmarks:true,privacy:true},records:{privacy:{data:{},time:1,device:'local'}}};
  find('1').children.push({id:String(++serial),title:'addition',url:'https://example.com/addition'});
  const before=clone(tree),requests=requestCount;
  await ok('keepCurrentBookmarks',{id:recovery.id});
  assert.deepEqual(tree,before);assert.equal(requestCount,requests);
  const {backups,journal,state,config:saved,status}=chrome.storage.local.values;
  assert.equal(journal,undefined);assert.equal(saved.auto,false);assert.match(status.message,/已保留当前/);
  assert.equal(backups.length,5);assert.ok(backups.some(b=>b.id===recovery.id));
  assert.match(backups[0].reason,/解除中断前/);assert.equal(backups[0].data.bookmarks.bar.length,3);
  assert.equal(state.initialized.bookmarks,false);assert.equal(state.initialized.privacy,true);assert.equal(state.records.privacy.time,1);
  assert.equal(state.records.bookmarks.hash,await hash(backups[0].data.bookmarks));
  cloud=await encrypt(doc('remote-only'),pass);etag++;
  await ok('sync');
  assert.deepEqual(find('1').children.map(n=>n.title),['remote-only','original','Folder','addition']);
  assert.equal(chrome.storage.local.values.state.initialized.bookmarks,true);
});

test('Keep-current recovery rejects missing content, stale or mixed recovery points and backup failures',async()=>{
  localBookmark('kept');
  const point={id:'guarded',time:1,reason:'test',data:{bookmarks:{bar:[{title:'missing',url:'https://example.com/missing'}],other:[],mobile:[]}}};
  chrome.storage.local.values.backups=[clone(point)];chrome.storage.local.values.journal={backupId:point.id};
  const before=clone(tree),requests=requestCount;
  assert.match((await message('keepCurrentBookmarks',{id:'wrong'})).error,/恢复点已变化/);
  assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/缺少恢复点/);
  assert.ok(chrome.storage.local.values.journal);
  chrome.storage.local.values.backups[0].data={bookmarks:{bar:[{title:'kept',url:'https://example.com/kept'}],other:[],mobile:[]},fonts:{DefaultFontSize:16}};
  assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/不只包含收藏夹/);
  delete chrome.storage.local.values.backups[0].data.fonts;
  // Duplicate links and empty folders count as content, too.
  chrome.storage.local.values.backups[0].data.bookmarks.bar.push({title:'kept',url:'https://example.com/kept'});
  assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/缺少恢复点/);
  chrome.storage.local.values.backups[0].data.bookmarks.bar.pop();
  chrome.storage.local.values.backups[0].data.bookmarks.other.push({title:'Empty folder',children:[]});
  assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/缺少恢复点/);
  chrome.storage.local.values.backups[0].data.bookmarks.other=[];
  const set=chrome.storage.local.set;
  try {
    chrome.storage.local.set=async v=>{if(v.backups)throw Error('备份空间不足');return set(v);};
    assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/空间不足/);
    assert.equal(chrome.storage.local.values.journal.backupId,point.id);
  } finally {chrome.storage.local.set=set;}
  assert.deepEqual(tree,before);assert.equal(requestCount,requests);
  // A bookmark edit during backup must leave the recovery marker in place.
  try {
    chrome.storage.local.set=async v=>{await set(v);if(v.backups){localBookmark('concurrent-edit');bookmarks.onChanged.listeners.forEach(fn=>fn());}};
    assert.match((await message('keepCurrentBookmarks',{id:point.id})).error,/发生变化/);
    assert.equal(chrome.storage.local.values.journal.backupId,point.id);
  } finally {chrome.storage.local.set=set;}
});
