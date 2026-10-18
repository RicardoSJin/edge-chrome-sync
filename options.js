import {endpoint} from './core.js';
const $=id=>document.getElementById(id);
const groups=['bookmarks','privacy','fonts'];
let dirty=false;
async function send(action,rest={}){const r=await chrome.runtime.sendMessage({action,...rest});if(!r?.ok)throw Error(r?.error||'无法连接后台，请重新加载扩展。');return r.data;}
function notify(text){$('status').textContent=text;}
function fields(){return Object.fromEntries(['url','username','password','pass','interval'].map(k=>[k,$(k).value]).concat(['auto','remember','consent'].map(k=>[k,$(k).checked]),[['groups',groups.filter(k=>$(k).checked)]]));}
function fill(c){for(const k of ['url','username','password','interval'])$(k).value=c[k]??'';for(const k of ['auto','remember','consent'])$(k).checked=!!c[k];for(const g of groups)$(g).checked=c.groups.includes(g);}
async function refresh(reset=false){
  const d=await send('load');if(reset){fill(d.config);$('pass').value='';dirty=false;}
  $('keyState').textContent=d.hasPass?'加密口令已保存在本机':'加密口令未设置 / 会话已锁定';
  $('pass').placeholder=d.hasPass?'已保存；留空保留现有口令':'至少 12 个字符，两端必须一致';
  if(d.status){notify(d.status.message);$('statusTime').textContent=new Date(d.status.time).toLocaleString();}
  $('recovery').hidden=!d.journal;if(d.journal)$('recovery').textContent='检测到未完成的覆盖操作。请恢复“中断恢复点”备份；若要保留当前收藏夹，可点击该备份下的“保留当前收藏夹并解除中断”，校验通过后解除。';
  $('backups').replaceChildren();
  if(!d.backups.length)$('backups').textContent='还没有备份';
  for(const b of d.backups){const item=document.createElement('div');item.className='backup';const text=document.createElement('p');text.textContent=new Date(b.time).toLocaleString()+' · '+b.reason+(d.journal?.backupId===b.id?' · 中断恢复点':'');item.append(text);
    const restore=document.createElement('button');restore.textContent='恢复';restore.onclick=()=>run(async()=>{if(confirm('恢复这份备份将覆盖对应的本地数据，并暂停自动同步。继续？')){await send('restore',{id:b.id});await refresh(true);}});
    const exportButton=document.createElement('button');exportButton.textContent='导出';exportButton.onclick=()=>run(async()=>{const data=await send('exportBackup',{id:b.id});const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='bridge-backup-'+b.time+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});item.append(restore,exportButton);$('backups').append(item);
    if(d.journal?.backupId===b.id){const keep=document.createElement('button');keep.textContent='保留当前收藏夹并解除中断';keep.onclick=()=>run(async()=>{if(confirm('将检查当前收藏夹是否包含恢复点中的全部内容，保存当前备份并暂停自动同步；检查通过后解除中断记录。不会覆盖收藏夹或写入云端。继续？')){await send('keepCurrentBookmarks',{id:b.id});await refresh(true);}});item.append(keep);}
  }
}
async function run(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){notify(e.message);}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
$('config').addEventListener('input',()=>{dirty=true;});
$('config').onsubmit=e=>{e.preventDefault();return run(async()=>{
  const c=fields();c.url=endpoint(c.url);
  // Request optional permissions directly from the user's save gesture.
  const granted=await chrome.permissions.request({origins:[new URL(c.url).origin+'/*'],permissions:c.groups.includes('privacy')?['privacy']:[]});
  if(!granted)throw Error('权限未授予，配置尚未保存。');
  await send('save',{config:c});await refresh(true);
});};
$('sync').onclick=()=>run(async()=>{if(dirty)throw Error('配置已修改，请先点击“保存配置”。');notify('正在加密并同步，请稍候…');await send('sync');await refresh();});
$('mergeBookmarks').onclick=()=>run(async()=>{if(dirty)throw Error('配置已修改，请先点击“保存配置”。');notify('正在合并本地与云端收藏夹，请稍候…');await send('mergeBookmarks');await refresh();});
$('diagnose').onclick=()=>run(async()=>{
  const c=fields();const url=endpoint(c.url);
  if(!await chrome.permissions.request({origins:[new URL(url).origin+'/*']}))throw Error('[站点权限缺失] 未允许访问 WebDAV，未发送检测请求。');
  notify('正在检测 WebDAV 目录，不会写入数据…');
  const result=await send('diagnose',{config:{url,username:c.username,password:c.password}});notify(result);
});
$('clearPass').onclick=()=>run(async()=>{await send('clearPass');$('pass').value='';await refresh(true);});
$('release').onclick=()=>run(async()=>{await send('release');await refresh(true);});
document.querySelectorAll('[data-reveal]').forEach(b=>b.onclick=()=>{const input=$(b.dataset.reveal);input.type=input.type==='password'?'text':'password';b.textContent=input.type==='password'?'显示':'隐藏';});
$('copy').onclick=()=>run(async()=>{const c=fields();delete c.password;delete c.pass;delete c.remember;delete c.consent;const text=JSON.stringify({format:'bridge-connection-v1',config:c},null,2);$('transfer').value=text;try{await navigator.clipboard.writeText(text);notify('连接配置已复制，不含服务器密码或加密口令。');}catch{notify('配置已放入文本框，请手动复制。');}});
$('import').onclick=()=>run(async()=>{const d=JSON.parse($('transfer').value);if(d.format!=='bridge-connection-v1'||!d.config||!Array.isArray(d.config.groups))throw Error('不是桥同步连接配置。');const c=d.config;endpoint(c.url);fill({...c,password:'',auto:false,remember:false,consent:false});$('pass').value='';dirty=true;notify('已填入连接配置。请填写密码和加密口令，然后保存。');});
refresh(true).catch(e=>notify(e.message));
