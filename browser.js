import {PRIVACY,FONTS,validateData} from './core.js';
export function api(obj,method,...args) { return new Promise((resolve,reject)=> {obj[method](...args,result=>{const err=chrome.runtime.lastError;err?reject(Error(err.message)):resolve(result);});}); }
export function roots(tree) {
  const found={};
  for(const n of tree[0].children||[]) {
    if(n.unmodifiable) continue;
    const type=({'bookmarks-bar':'bar',other:'other',mobile:'mobile'})[n.folderType] || ({'1':'bar','2':'other','3':'mobile'})[n.id];
    if(!type) {if(n.children?.length) throw Error('存在无法识别的收藏夹根目录，停止同步以保护数据。');continue;}
    if(found[type]) throw Error('存在账户与本地双份收藏夹根目录，请先在浏览器中整理后再同步。');
    found[type]=n;
  }
  if(!found.bar||!found.other) throw Error('无法识别收藏夹栏和其他收藏夹。');
  return found;
}
function clean(n) {if(n.unmodifiable) throw Error('收藏夹含受管理条目，无法安全替换。');return n.url!==undefined?{title:n.title,url:n.url}:{title:n.title,children:(n.children||[]).map(clean)};}
const setting = path=>path.split('.').reduce((o,k)=>o?.[k],chrome.privacy);
const controllable=d=>['controllable_by_this_extension','controlled_by_this_extension'].includes(d.levelOfControl);
export async function capture(group) {
  if(group==='bookmarks') {const r=roots(await api(chrome.bookmarks,'getTree'));return Object.fromEntries(['bar','other','mobile'].map(k=>[k,(r[k]?.children||[]).map(clean)]));}
  const out={};
  if(group==='privacy') for(const path of PRIVACY) {const s=setting(path);if(s){const d=await api(s,'get',{});if(controllable(d))out[path]=d.value;}}
  if(group==='fonts') for(const name of FONTS) {const d=await api(chrome.fontSettings,'get'+name,{});if(controllable(d))out[name]=d.pixelSize;}
  return out;
}
export async function preflight(group,data) {
  validateData(group,data);
  if(group==='bookmarks') {
    const r=roots(await api(chrome.bookmarks,'getTree'));
    for(const [k,nodes] of Object.entries(data)) if(!r[k]&&nodes.length) throw Error('目标浏览器缺少移动收藏夹目录，无法无损同步。');
    Object.values(r).forEach(n=>(n.children||[]).forEach(clean));
  } else for(const k of Object.keys(data)) {
    if(group==='privacy'&&!setting(k)) throw Error('目标浏览器不支持一项隐私设置。');
    const d=group==='privacy'?await api(setting(k),'get',{}):await api(chrome.fontSettings,'get'+k,{});
    if(!controllable(d)) throw Error('设置被浏览器策略或其他扩展控制，已停止覆盖。');
  }
}
export async function apply(group,data) {
  if(group==='bookmarks')data={...data,mobile:data.mobile||[]};
  await preflight(group,data);
  if(group==='bookmarks') {
    const r=roots(await api(chrome.bookmarks,'getTree'));
    const created=[];
    async function add(parentId,n,top=false) {
      const made=await api(chrome.bookmarks,'create',{parentId,title:n.title,...(n.url!==undefined?{url:n.url}:{})});
      if(top)created.push(made.id);
      for(const c of n.children||[]) await add(made.id,c);
    }
    // Create every replacement first. If creation fails, originals are intact.
    try {for(const [k,nodes] of Object.entries(data)) for(const n of nodes) await add(r[k].id,n,true);}
    catch(e) {for(const id of created) await api(chrome.bookmarks,'removeTree',id).catch(()=>{});throw e;}
    for(const k of Object.keys(data)) for(const n of r[k]?.children||[]) await api(chrome.bookmarks,'removeTree',n.id);
  } else for(const [k,v] of Object.entries(data)) {
    if(group==='privacy') await api(setting(k),'set',{value:v,scope:'regular'});
    else await api(chrome.fontSettings,'set'+k,{pixelSize:v});
  }
}
export async function releaseSettings() {
  if(await chrome.permissions.contains({permissions:['privacy']})) for(const p of PRIVACY) {const s=setting(p);if(s)await api(s,'clear',{scope:'regular'});}
  if(await chrome.permissions.contains({permissions:['fontSettings']})) for(const f of FONTS) await api(chrome.fontSettings,'clear'+f,{});
}
