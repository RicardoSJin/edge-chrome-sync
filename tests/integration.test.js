import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt} from '../core.js';
const clone=x=>structuredClone(x);
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
function storage(){const values={};return {values,async get(keys){const out={};for(const k of typeof keys==='string'?[keys]:keys)if(k in values)out[k]=clone(values[k]);return out;},async set(v){Object.assign(values,clone(v));},async remove(keys){for(const k of typeof keys==='string'?[keys]:keys)delete values[k];},async setAccessLevel(){}};}
let serial=10,failCreate=false,failRemove=false;
const tree=[{id:'0',children:[{id:'1',title:'Bookmarks bar',children:[]},{id:'2',title:'Other bookmarks',children:[]}]}];
function find(id,n=tree[0]) {if(n.id===id)return n;for(const child of n.children||[]){const result=find(id,child);if(result)return result;}}
const bookmarks={getTree(cb){cb(clone(tree));},create(input,cb){if(failCreate){chrome.runtime.lastError={message:'模拟写入失败'};cb();delete chrome.runtime.lastError;return;}const n={...input,id:String(++serial),...(input.url===undefined?{children:[]}:{})};find(input.parentId).children.push(n);cb(clone(n));},removeTree(id,cb){if(failRemove){chrome.runtime.lastError={message:'模拟删除中断'};cb();delete chrome.runtime.lastError;return;}const search=n=>{if(n.children){n.children=n.children.filter(c=>c.id!==id);n.children.forEach(search);}};search(tree[0]);cb();}};
for(const name of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded'])bookmarks[name]=event();
let permissionGranted=true;
globalThis.chrome={runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:event(),onInstalled:event(),onStartup:event(),openOptionsPage(){}},storage:{local:storage(),session:storage()},bookmarks,permissions:{async contains(){return permissionGranted;}},alarms:{onAlarm:event(),async create(){},async clear(){}},action:{onClicked:event()}};
let cloud=null,etag=0,conflict=false,putCount=0;
globalThis.fetch=async(url,o)=>{
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
