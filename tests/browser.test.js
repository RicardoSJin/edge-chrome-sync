import {test} from 'node:test';
import assert from 'node:assert/strict';
import {roots,capture,preflight,apply,releaseSettings} from '../browser.js';
import {PRIVACY,FONTS} from '../core.js';
test('Root mapping: translated titles, mobile absence, managed roots and dual account roots',()=>{
  const root=children=>[{children}];const bar={id:'1',title:'收藏夹栏'},other={id:'2',title:'其他收藏夹'};
  assert.deepEqual(roots(root([bar,other])),{bar,other});
  assert.throws(()=>roots(root([bar,other,{id:'9',folderType:'bookmarks-bar'}])),/双份/);
  assert.throws(()=>roots(root([bar,other,{id:'8',children:[{}]}])),/无法识别/);
  assert.deepEqual(roots(root([bar,other,{id:'8',unmodifiable:'managed'}])),{bar,other});
});
test('Settings capture, application, policy rejection and release',async()=>{
  const values={},cleared=[];globalThis.chrome={runtime:{},privacy:{network:{},services:{},websites:{}},fontSettings:{},permissions:{async contains(){return true;}}};
  for(const p of PRIVACY){values[p]={value:true,levelOfControl:'controllable_by_this_extension'};const [a,b]=p.split('.');chrome.privacy[a][b]={get(o,cb){cb(values[p]);},set(o,cb){values[p].value=o.value;cb();},clear(o,cb){cleared.push(p);cb();}};}
  for(const f of FONTS){values[f]={pixelSize:16,levelOfControl:'controllable_by_this_extension'};chrome.fontSettings['get'+f]=(o,cb)=>cb(values[f]);chrome.fontSettings['set'+f]=(o,cb)=>{values[f].pixelSize=o.pixelSize;cb();};chrome.fontSettings['clear'+f]=(o,cb)=>{cleared.push(f);cb();};}
  assert.equal(Object.keys(await capture('privacy')).length,7);assert.equal(Object.keys(await capture('fonts')).length,3);
  await apply('privacy',{'services.searchSuggestEnabled':false});assert.equal(values['services.searchSuggestEnabled'].value,false);
  await apply('fonts',{DefaultFontSize:20});assert.equal(values.DefaultFontSize.pixelSize,20);
  values.DefaultFontSize.levelOfControl='controlled_by_other_extensions';await assert.rejects(preflight('fonts',{DefaultFontSize:18}),/控制/);
  await releaseSettings();assert.equal(cleared.length,10);
});
