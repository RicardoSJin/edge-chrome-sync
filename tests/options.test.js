import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Saving font sync requests only declared optional permissions and preserves selected groups',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.ok(manifest.permissions.includes('fontSettings'));
  assert.ok(!manifest.optional_permissions.includes('fontSettings'));
  const previous={chrome:globalThis.chrome,document:globalThis.document};
  const elements=new Map(),requests=[],saves=[];
  let config={url:'https://nas.example/sync/',username:'test',password:'',groups:['bookmarks'],interval:15,auto:false,remember:false,consent:true};
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',checked:false,addEventListener(){},replaceChildren(){},append(){}});
    return elements.get(id);
  };
  globalThis.document={getElementById:element,querySelectorAll:()=>[]};
  globalThis.chrome={
    permissions:{async request(request){
      // Simulate the API rejecting requests for undeclared/required permissions.
      for(const permission of request.permissions||[])assert.ok(manifest.optional_permissions.includes(permission),'Permission cannot be requested as optional: '+permission);
      requests.push(request);return true;
    }},
    runtime:{async sendMessage(message){
      if(message.action==='load')return {ok:true,data:{config,hasPass:true,backups:[]}};
      if(message.action==='save'){config=message.config;saves.push(config);return {ok:true};}
      throw Error('Unexpected action: '+message.action);
    }}
  };
  try {
    await import('../options.js');
    await new Promise(resolve=>setImmediate(resolve));
    element('fonts').checked=true;
    await element('config').onsubmit({preventDefault(){}});
    assert.deepEqual(requests[0],{origins:['https://nas.example/*'],permissions:[]});
    assert.deepEqual(saves[0].groups,['bookmarks','fonts']);
    element('privacy').checked=true;
    await element('config').onsubmit({preventDefault(){}});
    assert.deepEqual(requests[1],{origins:['https://nas.example/*'],permissions:['privacy']});
    assert.deepEqual(saves[1].groups,['bookmarks','privacy','fonts']);
  } finally {
    globalThis.chrome=previous.chrome;globalThis.document=previous.document;
  }
});
