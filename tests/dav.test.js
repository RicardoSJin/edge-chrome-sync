import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebDAV} from '../dav.js';
const config={url:'https://nas.example/browser/',username:'u',password:'p'};
test('Default fetch keeps its native global receiver',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async function(){assert.equal(this,globalThis);return new Response('<multistatus/>',{status:207});};
  try {assert.match(await new WebDAV(config).diagnose(),/HTTP 207/);}finally{globalThis.fetch=original;}
});
function server(initial=null){
  let cloud=initial,locked=false,writes=0,unlocks=0,etag=1;
  const token='<urn:uuid:test-lock>';
  return {get cloud(){return cloud;},get locked(){return locked;},get writes(){return writes;},get unlocks(){return unlocks;},
    change(doc){cloud=doc;},
    async fetch(url,o){
      if(o.method==='LOCK'){if(locked)return new Response(null,{status:423});locked=true;return new Response(null,{status:cloud?200:201,headers:{'Lock-Token':token}});}
      if(o.method==='UNLOCK'){assert.equal(o.headers['Lock-Token'],token);locked=false;unlocks++;return new Response(null,{status:204});}
      if(o.method==='GET')return new Response(cloud?JSON.stringify(cloud):'',{headers:{etag:'"'+etag+'"'}});
      if(o.method==='DELETE'){assert.equal(o.headers.If,'('+token+')');cloud=null;return new Response(null,{status:204});}
      if(o.method==='PUT'){assert.equal(locked,true);assert.equal(o.headers.If,'('+token+')');writes++;cloud=JSON.parse(o.body);etag++;return new Response(null,{status:201});}
      throw Error('unexpected method '+o.method);
    }};
}
test('Exclusive locks support first upload and reject stale clients even when ETag does not change',async()=>{
  const s=server(),dav=new WebDAV(config,(...a)=>s.fetch(...a));
  await dav.write({data:'first'},{doc:null,etag:null});assert.deepEqual(s.cloud,{data:'first'});assert.equal(s.locked,false);
  const previous=await dav.read();
  s.change({data:'other client'});
  await assert.rejects(dav.write({data:'stale'},previous),/HTTP 412/);assert.equal(s.writes,1);assert.equal(s.locked,false);assert.equal(s.unlocks,2);
  const current=await dav.read();await dav.write({data:'updated'},current);assert.deepEqual(s.cloud,{data:'updated'});assert.equal(s.locked,false);
});
test('Competing locks and failed first upload preserve cloud and release locks',async()=>{
  const s=server(),dav=new WebDAV(config,(...a)=>s.fetch(...a));
  await s.fetch('',{method:'LOCK'});await assert.rejects(dav.write({},{doc:null}),/HTTP 423/);assert.equal(s.writes,0);
  const failing=server();const bad=new WebDAV(config,(url,o)=>o.method==='PUT'?Promise.reject(new TypeError('network failed')):failing.fetch(url,o));
  await assert.rejects(bad.write({},{doc:null,etag:null}),/网络连接失败/);assert.equal(failing.cloud,null);assert.equal(failing.locked,false);assert.equal(failing.unlocks,1);
});
