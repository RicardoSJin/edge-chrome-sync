export const FORMAT = 'bridge-sync-v1';
export const ITERATIONS = 600000;
export const LIMIT = 16 * 1024 * 1024;
export const PRIVACY = ['network.networkPredictionEnabled','services.alternateErrorPagesEnabled','services.autofillAddressEnabled','services.autofillCreditCardEnabled','services.passwordSavingEnabled','services.searchSuggestEnabled','websites.doNotTrackEnabled'];
export const FONTS = ['DefaultFontSize','DefaultFixedFontSize','MinimumFontSize'];
export const encode = x => new TextEncoder().encode(x);
export const b64 = bytes => { let s=''; for (const b of new Uint8Array(bytes)) s+=String.fromCharCode(b); return btoa(s); };
export const unb64 = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
// Extension storage may reorder object keys. Array order still represents
// bookmark order and must remain significant.
export async function hash(value) {
  const json=JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
  return b64(await crypto.subtle.digest('SHA-256', encode(json)));
}
async function key(pass, salt) {
  if (typeof pass !== 'string' || pass.length < 12) throw Error('加密口令至少需要 12 个字符。');
  const material=await crypto.subtle.importKey('raw',encode(pass),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encrypt(value, pass) {
  const salt=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=encode(JSON.stringify(value));
  if (plaintext.length > LIMIT / 2) throw Error('数据过大，停止同步。');
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encode(FORMAT)},await key(pass,salt),plaintext);
  return {format:FORMAT,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:b64(salt),iv:b64(iv),data:b64(data)};
}
export async function decrypt(envelope, pass) {
  if (!envelope || envelope.format!==FORMAT || envelope.kdf!=='PBKDF2-SHA256' || envelope.iterations!==ITERATIONS || typeof envelope.data!=='string' || envelope.data.length>LIMIT) throw Error('不支持或损坏的加密文件。');
  try {
    const salt=unb64(envelope.salt),iv=unb64(envelope.iv);
    if(salt.length!==16 || iv.length!==12) throw Error();
    const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encode(FORMAT)},await key(pass,salt),unb64(envelope.data));
    return JSON.parse(new TextDecoder().decode(raw));
  } catch { throw Error('解密失败：口令不匹配或云端文件已损坏。未覆盖任何数据。'); }
}
export function endpoint(input) {
  const u=new URL(input);
  if(u.protocol!=='https:' || u.username || u.password || u.search || u.hash) throw Error('请输入 HTTPS WebDAV 文件夹地址，不含账户、查询参数或片段。');
  if(!u.pathname.endsWith('/')) u.pathname+='/';
  return u.href;
}
export function validateData(group, data) {
  if (!data || typeof data!=='object' || Array.isArray(data)) throw Error('数据结构无效。');
  if(group==='bookmarks') {
    let count=0;
    const visit=(nodes,depth)=>{
      if(!Array.isArray(nodes)||depth>64) throw Error('收藏夹层级无效。');
      for(const n of nodes) {
        if(++count>50000 || !n || typeof n.title!=='string' || n.title.length>10000) throw Error('收藏夹数据无效。');
        if(Object.hasOwn(n,'url')) { if(typeof n.url!=='string'||n.url.length>100000 || !/^[a-z][a-z0-9+.-]*:/i.test(n.url) || n.children!==undefined) throw Error('收藏夹网址无效。'); }
        else visit(n.children,depth+1);
      }
    };
    if(!Object.hasOwn(data,'bar') || !Object.hasOwn(data,'other')) throw Error('缺少收藏夹根目录。');
    for(const [k,v] of Object.entries(data)) { if(!['bar','other','mobile'].includes(k)) throw Error('未知收藏夹根目录。'); visit(v,0); }
  } else if(group==='privacy') {
    for(const [k,v] of Object.entries(data)) if(!PRIVACY.includes(k)||typeof v!=='boolean') throw Error('隐私设置数据无效。');
  } else if(group==='fonts') {
    for(const [k,v] of Object.entries(data)) if(!FONTS.includes(k)||!Number.isInteger(v)||v<0||v>100) throw Error('字号设置数据无效。');
  } else throw Error('未知同步类别。');
  return data;
}
export function validateDoc(doc) {
  if(!doc || doc.version!==1 || !doc.groups || typeof doc.groups!=='object' || Array.isArray(doc.groups)) throw Error('不支持的同步数据版本。');
  for(const [group,r] of Object.entries(doc.groups)) {
    if(!r || !Number.isSafeInteger(r.time)||r.time<0||r.time>Date.now()+300000||typeof r.device!=='string'||r.device.length>100) throw Error('修改时间或设备信息异常，请检查系统时间。');
    validateData(group,r.data);
  }
  return doc;
}
// Categories are independent snapshots. A tie goes to the remote snapshot.
export function winner(local,remote,first) { return remote && (first || !local || remote.time>=local.time) ? remote : local; }
// Recovery-only containment check. Duplicate folders are paired by occurrence;
// no snapshot is combined or written by this function.
export function bookmarksContain(current,required) {
  validateData('bookmarks',current);validateData('bookmarks',required);
  const contains=(a,b)=>{
    const slots=new Map();
    const key=n=>JSON.stringify(n.url!==undefined?['url',n.title,n.url]:['folder',n.title]);
    a.forEach((n,i)=>{const k=key(n);if(!slots.has(k))slots.set(k,{indices:[],next:0});slots.get(k).indices.push(i);});
    for(const n of b) {
      const slot=slots.get(key(n)),i=slot?.indices[slot.next++];
      if(i===undefined||n.url===undefined&&!contains(a[i].children,n.children))return false;
    }
    return true;
  };
  return ['bar','other','mobile'].every(k=>contains(current[k]||[],required[k]||[]));
}
