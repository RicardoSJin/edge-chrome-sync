import {encrypt,decrypt,endpoint,hash,validateDoc,winner,mergeBookmarks,PRIVACY,FONTS} from './core.js';
import {capture,apply,preflight,releaseSettings} from './browser.js';
import {WebDAV} from './dav.js';
let busy=false, applying=false, generation=0, pendingEvent=Promise.resolve();
const local=chrome.storage.local, session=chrome.storage.session;
const initial={url:'',username:'',password:'',groups:['bookmarks'],interval:15,auto:false,remember:false,consent:false};
async function secret() {const s=await session.get('pass'),l=await local.get('pass');return s.pass||l.pass;}
async function backup(data,reason,protectedId) {
  const {backups=[]}=await local.get('backups');
  const record={id:crypto.randomUUID(),time:Date.now(),reason,data};
  const pinned=backups.find(b=>b.id===protectedId);
  const retained=pinned?[record,pinned,...backups.filter(b=>b.id!==protectedId)].slice(0,5):[record,...backups].slice(0,5);
  await local.set({backups:retained});return record.id;
}
async function status(message,ok=false) {await local.set({status:{message,ok,time:Date.now()}});}
async function requireHost(url) {
  const origin=new URL(endpoint(url)).origin+'/*';
  if(!await chrome.permissions.contains({origins:[origin]}))throw Error('[站点权限缺失] 请点击“检测连接”或重新保存配置，并允许访问 WebDAV 站点。也请检查扩展详情中的站点访问限制。');
}
async function sync({mergeOnly=false}={}) {
  await pendingEvent;
  const {config:savedConfig=initial,state={},journal}=await local.get(['config','state','journal']);
  if(mergeOnly&&!savedConfig.groups.includes('bookmarks'))throw Error('请先勾选收藏夹并保存配置，再合并。');
  const config=mergeOnly?{...savedConfig,groups:['bookmarks']}:savedConfig;
  if(journal) throw Error('上次应用数据被中断。请先在备份区恢复，再继续同步。');
  if(!config.consent) throw Error('请先确认首次同步规则并保存配置。');
  await requireHost(config.url);
  const pass=await secret();if(!pass)throw Error('请填写独立加密口令并保存后同步。');
  const startGeneration=generation;
  const device=state.device||crypto.randomUUID();
  const current={}, records={...state.records}, initialized={...state.initialized};
  for(const group of config.groups) {
    current[group]=await capture(group);
    const digest=await hash(current[group]);
    // Compare stored content, not legacy order-sensitive hashes. Upgrading
    // must not make an unchanged local snapshot appear newer than the cloud.
    if(!records[group] || await hash(records[group].data)!==digest) {
      const mark=(await local.get('changed_'+group))['changed_'+group];
      const observed=mark>(records[group]?.time||0)?mark:Date.now();
      records[group]={data:current[group],time:Math.max(observed,(records[group]?.time||0)+1),device,hash:digest};
    } else records[group]={...records[group],hash:digest};
  }
  // Persist observed edits before networking so a retry cannot refresh their timestamps.
  await local.set({state:{...state,device,records,initialized}});
  const dav=new WebDAV(config),remote=await dav.read();
  const cloud=remote.doc?validateDoc(await decrypt(remote.doc,pass)):{version:1,groups:{}};
  const merged={version:1,groups:{...cloud.groups}},changes={};
  let mergingBookmarks=mergeOnly;
  for(const group of config.groups) {
    let win=winner(records[group],cloud.groups[group],!initialized[group]);
    if(group==='bookmarks'&&cloud.groups.bookmarks&&(mergeOnly||!initialized.bookmarks)) {
      mergingBookmarks=true;
      const data=mergeBookmarks(cloud.groups.bookmarks.data,current.bookmarks);
      win=await hash(data)===await hash(cloud.groups.bookmarks.data)?cloud.groups.bookmarks:
        {data,time:Math.max(Date.now(),cloud.groups.bookmarks.time+1,records.bookmarks.time+1),device};
    }
    merged.groups[group]={data:win.data,time:win.time,device:win.device};
    if(await hash(win.data)!==await hash(current[group])) changes[group]=win.data;
  }
  for(const [g,data] of Object.entries(changes)) await preflight(g,data);
  const assertUnchanged=async()=>{
    if(generation!==startGeneration)throw Error('同步期间本地数据发生变化，已停止应用。请重新同步。');
    for(const g of config.groups) if(await hash(await capture(g))!==await hash(current[g]))throw Error('同步期间本地数据发生变化，请重新同步。');
  };
  await assertUnchanged();
  const needsWrite=await hash(merged)!==await hash(cloud);
  let backupId;
  if(Object.keys(changes).length || (mergingBookmarks&&needsWrite)) backupId=await backup(current,mergingBookmarks?'收藏夹合并前自动备份':'云端覆盖前自动备份');
  if(needsWrite) {const encrypted=await encrypt(merged,pass);await assertUnchanged();await dav.write(encrypted,remote);}
  await assertUnchanged();
  if(Object.keys(changes).length) {
    await local.set({journal:{backupId,time:Date.now()}});
    applying=true;
    try {for(const [g,data] of Object.entries(changes)) await apply(g,data);}
    finally {applying=false;}
    for(const g of Object.keys(changes)) if(await hash(await capture(g))!==await hash(changes[g]))throw Error('应用结果与云端不一致，请从备份恢复。');
  }
  for(const g of config.groups) {records[g]={...merged.groups[g],hash:await hash(merged.groups[g].data)};initialized[g]=true;}
  await local.set({state:{device,records,initialized}});
  await local.remove('journal');
  await status(`同步成功 · ${config.groups.map(g=>({bookmarks:'收藏夹',privacy:'隐私偏好',fonts:'字号'})[g]).join('、')}${mergingBookmarks?'（收藏夹已合并，保留两端内容）':''}`,true);
}
async function save(input) {
  const old=(await local.get('config')).config||initial;
  const config={url:endpoint(input.url),username:String(input.username||''),password:String(input.password||''),groups:['bookmarks','privacy','fonts'].filter(g=>input.groups?.includes(g)),interval:Number(input.interval),auto:!!input.auto,remember:!!input.remember,consent:!!input.consent};
  if(!config.groups.length||![5,15,30,60].includes(config.interval)||!config.consent)throw Error('请选择同步项目、有效间隔，并确认首次同步规则。');
  if(config.username.includes(':'))throw Error('WebDAV 账户名不能包含冒号。');
  for(const g of config.groups.filter(g=>g!=='bookmarks'))if(!await chrome.permissions.contains({permissions:[g==='fonts'?'fontSettings':g]}))throw Error('未授予所选设置的权限。');
  await requireHost(config.url);
  const pass=input.pass||await secret();if(!pass||pass.length<12)throw Error('加密口令至少需要 12 个字符。');
  const {journal}=await local.get('journal');if(journal)throw Error('请先恢复中断前的备份，再更改配置。');
  const {state={}}=await local.get('state');
  if(old.url!==config.url||old.username!==config.username) {state.initialized={};state.records={};}
  else for(const g of config.groups) if(!old.groups.includes(g)) {if(state.initialized)delete state.initialized[g];if(state.records)delete state.records[g];}
  await session.set({pass});
  if(config.remember)await local.set({pass});else await local.remove('pass');
  await local.set({config,state});
  await chrome.alarms.clear('periodic');
  if(config.auto)await chrome.alarms.create('periodic',{periodInMinutes:config.interval});
  await status('配置已保存。');
}
async function restore(id) {
  const {backups=[],state={}}=await local.get(['backups','state']);const b=backups.find(x=>x.id===id);if(!b)throw Error('备份不存在。');
  for(const [g,data] of Object.entries(b.data))await preflight(g,data);
  const before={};for(const g of Object.keys(b.data))before[g]=await capture(g);
  await backup(before,'手动恢复前自动备份',id);
  await local.set({journal:{backupId:id,time:Date.now()}});
  applying=true;try {for(const [g,data] of Object.entries(b.data))await apply(g,data);}finally{applying=false;}
  for(const [g,data] of Object.entries(b.data))if(await hash(await capture(g))!==await hash(data))throw Error('恢复未完成，请检查收藏夹和浏览器设置。');
  const records={...state.records},initialized={...state.initialized};
  for(const [g,data] of Object.entries(b.data)){records[g]={data,time:Math.max(Date.now(),(records[g]?.time||0)+1),device:state.device||crypto.randomUUID(),hash:await hash(data)};initialized[g]=true;}
  await local.set({state:{...state,records,initialized}});await local.remove('journal');
  await status('备份已恢复。自动同步已暂停，请检查后手动同步。',true);
}
async function pause() {const {config=initial}=await local.get('config');await local.set({config:{...config,auto:false}});await chrome.alarms.clear('periodic');await chrome.alarms.clear('changed');}
async function keepCurrentBookmarks(id) {
  await pendingEvent;
  const startGeneration=generation;
  const {backups=[],state={},journal}=await local.get(['backups','state','journal']);
  if(!journal||journal.backupId!==id)throw Error('中断恢复点已变化，请刷新页面后重试。');
  const b=backups.find(x=>x.id===id);
  if(!b||Object.keys(b.data).length!==1||!b.data.bookmarks)throw Error('此恢复点不只包含收藏夹或已丢失，请使用备份恢复。');
  const current=await capture('bookmarks'),digest=await hash(current);
  if(await hash(mergeBookmarks(current,b.data.bookmarks))!==digest)throw Error('当前收藏夹缺少恢复点中的内容，未解除中断。请导出当前收藏夹及恢复点备份后处理。');
  const assertUnchanged=async()=>{
    if(generation!==startGeneration||await hash(await capture('bookmarks'))!==digest)throw Error('校验期间收藏夹发生变化，未解除中断，请重试。');
  };
  await backup({bookmarks:current},'保留当前收藏夹解除中断前自动备份',id);
  await assertUnchanged();
  const device=state.device||crypto.randomUUID();
  const records={...state.records,bookmarks:{data:current,time:Math.max(Date.now(),(state.records?.bookmarks?.time||0)+1),device,hash:digest}};
  // The next sync must merge again, since an interrupted operation may have
  // changed either side. Keep other groups' initialization state intact.
  await local.set({state:{...state,device,records,initialized:{...state.initialized,bookmarks:false}}});
  await assertUnchanged();
  await local.remove('journal');
  await status('已保留当前收藏夹并解除中断。自动同步已暂停；下次同步将先合并两端收藏夹。',true);
}
async function dispatch(m) {
  if(m.action==='load') {const d=await local.get(['config','status','backups','journal']);return {...d,config:d.config||initial,hasPass:!!await secret(),backups:(d.backups||[]).map(({id,time,reason})=>({id,time,reason}))};}
  if(m.action==='save')return save(m.config);
  if(m.action==='diagnose') {
    const config={url:endpoint(m.config.url),username:String(m.config.username||''),password:String(m.config.password||'')};
    if(config.username.includes(':'))throw Error('WebDAV 账户名不能包含冒号。');
    await requireHost(config.url);
    const result=await new WebDAV(config).diagnose();
    await status(result,true);return result;
  }
  if(m.action==='sync')return sync();
  if(m.action==='mergeBookmarks')return sync({mergeOnly:true});
  if(m.action==='clearPass') {await session.remove('pass');await local.remove('pass');await pause();return status('本地加密口令已清除，自动同步已暂停。云端文件未更改。');}
  if(m.action==='restore'){await pause();return restore(m.id);}
  if(m.action==='keepCurrentBookmarks'){await pause();return keepCurrentBookmarks(m.id);}
  if(m.action==='release'){await pause();await releaseSettings();return status('已释放隐私与字号设置控制，自动同步已暂停。');}
  if(m.action==='exportBackup'){const {backups=[]}=await local.get('backups');return backups.find(x=>x.id===m.id);}
  throw Error('不支持的操作。');
}
async function locked(fn) {if(busy)throw Error('已有操作正在进行，请稍候。');busy=true;try{return await fn();}finally{busy=false;}}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('options.html'))return false;
  (m.action==='load'?dispatch(m):locked(()=>dispatch(m))).then(data=>respond({ok:true,data})).catch(async e=>{await status(e.message);respond({ok:false,error:e.message});});return true;
});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.alarms.onAlarm.addListener(async a=>{if(!['periodic','changed'].includes(a.name)||busy)return;const {config}=await local.get('config');if(config?.auto)await locked(sync).catch(e=>status(e.message));});
function changed(group){if(applying)return;generation++;const time=Date.now();pendingEvent=pendingEvent.then(()=>local.set({['changed_'+group]:time})).catch(()=>{});chrome.alarms.create('changed',{delayInMinutes:0.5});}
for(const event of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded'])chrome.bookmarks[event]?.addListener(()=>changed('bookmarks'));
for(const p of PRIVACY)p.split('.').reduce((o,k)=>o?.[k],chrome.privacy)?.onChange?.addListener(()=>changed('privacy'));
for(const f of FONTS)chrome.fontSettings?.['on'+f+'Changed']?.addListener(()=>changed('fonts'));
async function boot(){await local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});const {config}=await local.get('config');if(config?.auto)await chrome.alarms.create('periodic',{periodInMinutes:config.interval});}
chrome.runtime.onInstalled.addListener(boot);chrome.runtime.onStartup.addListener(boot);
