import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,endpoint,validateDoc,winner} from '../core.js';
import {WebDAV} from '../dav.js';
const pass='独立的长加密口令-test-123';
const data={version:1,groups:{bookmarks:{time:100,device:'a',data:{bar:[{title:'中文目录',children:[{title:'示例',url:'https://example.org'}]}],other:[],mobile:[]}}}};
test('Unicode roundtrip, randomized encryption, incorrect key and tamper rejection',async()=>{
  const a=await encrypt(data,pass),b=await encrypt(data,pass);assert.notEqual(a.data,b.data);assert.notEqual(a.salt,b.salt);
  assert.deepEqual(await decrypt(a,pass),data);assert.ok(!JSON.stringify(a).includes('example.org'));
  await assert.rejects(decrypt(a,pass+'wrong'),/解密失败/);
  await assert.rejects(decrypt({...a,data:(a.data[0]==='A'?'B':'A')+a.data.slice(1)},pass),/解密失败/);
  await assert.rejects(decrypt({...a,iterations:1},pass),/不支持/);
  await assert.rejects(encrypt(data,'short'),/12/);
});
test('Endpoint validation disallows plaintext, credentials and query',()=>{
  assert.equal(endpoint('https://nas.example:15006/sync/config'),'https://nas.example:15006/sync/config/');
  for(const u of ['http://nas.example/','https://u:p@nas.example/','https://nas.example/?token=x','file:///tmp/'])assert.throws(()=>endpoint(u));
});
test('Remote validation rejects unknown groups, bad settings and future timestamps',()=>{
  assert.equal(validateDoc(data),data);
  for(const groups of [{unknown:{time:1,device:'x',data:{}}},{privacy:{time:1,device:'x',data:{'services.searchSuggestEnabled':'yes'}}},{bookmarks:{...data.groups.bookmarks,time:Date.now()+600000}}])assert.throws(()=>validateDoc({version:1,groups}));
});
test('First cloud wins, later newer wins, equal timestamp converges to cloud',()=>{
  const a={time:200},b={time:100};assert.equal(winner(a,b,true),b);assert.equal(winner(a,b,false),a);assert.equal(winner(a,{time:200},false).time,200);assert.equal(winner(a,null,true),a);
});
test('WebDAV conditional requests and conflict/auth/ETag errors',async()=>{
  const config={url:'https://nas.example/folder/',username:'用户',password:'secret'};const calls=[];
  const dav=new WebDAV(config,async(url,options)=>{calls.push({url,options});return new Response('{}',{status:200,headers:{etag:'"v1"'}});});
  const prev=await dav.read();await dav.write({},prev);assert.equal(calls[1].options.headers['If-Match'],'"v1"');assert.equal(calls[0].options.redirect,'manual');
  await dav.write({},{doc:null});assert.equal(calls[2].options.headers['If-None-Match'],'*');
  await assert.rejects(dav.write({},{doc:{},etag:null}),/ETag/);await assert.rejects(dav.write({},{doc:{},etag:'W/"1"'}),/ETag/);
  for(const code of [401,403,409,412,500]) {const fail=new WebDAV(config,async()=>new Response('',{status:code}));await assert.rejects(fail.write({},{doc:null}));}
  const missing=new WebDAV(config,async()=>new Response('',{status:404}));assert.deepEqual(await missing.read(),{doc:null,etag:null});
});
test('Connection diagnostics distinguish transport, timeout, redirects and HTTP errors',async()=>{
  const config={url:'https://nas.example/folder/',username:'u',password:'not-logged'};
  for(const [error,pattern] of [[new TypeError('private-detail'),/网络连接失败/],[new DOMException('timeout','TimeoutError'),/连接超时/]]) {
    const dav=new WebDAV(config,async()=>{throw error;});await assert.rejects(dav.read(),e=>pattern.test(e.message)&&!e.message.includes('private-detail'));
  }
  for(const response of [{type:'opaqueredirect',status:0},new Response('',{status:302,headers:{Location:'https://other.example/'}})]) {
    let calls=0;const dav=new WebDAV(config,async()=>{calls++;return response;});await assert.rejects(dav.read(),/地址重定向/);assert.equal(calls,1);
  }
  const requests=[];const dav=new WebDAV(config,async(url,options)=>{requests.push({url,options});return new Response('<multistatus/>',{status:207});});
  assert.match(await dav.diagnose(),/尚未验证写权限/);assert.equal(requests.length,1);assert.equal(requests[0].url,config.url);assert.equal(requests[0].options.method,'PROPFIND');assert.equal(requests[0].options.headers.Depth,'0');
  for(const code of [401,403,404,405,501,200]) {const fail=new WebDAV(config,async()=>new Response('',{status:code}));await assert.rejects(fail.diagnose(),new RegExp('HTTP '+code));}
});
