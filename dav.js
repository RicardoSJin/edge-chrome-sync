import {endpoint,LIMIT,b64,encode} from './core.js';
export class WebDAV {
  // Window.fetch requires its native receiver; never call it as a WebDAV method.
  constructor(config, fetcher=(...args)=>globalThis.fetch(...args)) { this.directory=endpoint(config.url); this.url=this.directory+'bridge-sync-v1.enc.json'; this.auth='Basic '+b64(encode(config.username+':'+config.password)); this.fetcher=fetcher; }
  async request(method,headers={},body,url=this.url) {
    let response;
    try { response=await this.fetcher(url,{method,headers:{Authorization:this.auth,...headers},body,cache:'no-store',credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(20000)}); }
    catch (error) {
      if(['TimeoutError','AbortError'].includes(error?.name)) throw Error(`[连接超时] WebDAV ${method} 在 20 秒内未完成。请检查服务器、端口与代理路径。`);
      throw Error(`[网络连接失败] WebDAV ${method} 未取得 HTTP 响应。浏览器未提供具体原因；请检查系统/Clash 代理、DNS、HTTPS 证书和浏览器站点访问限制。此提示不代表发生了重定向，也与数据加密口令无关。`);
    }
    if(response.type==='opaqueredirect'||[301,302,303,307,308].includes(response.status)) throw Error('[地址重定向] WebDAV 返回了跳转，插件未跟随或向跳转地址转发密码。请填写最终 HTTPS WebDAV 目录地址，勿填写网页登录地址。');
    if(response.status===401) throw Error('[HTTP 401] WebDAV 已连接，但账户或服务器密码验证失败。请检查同步账户和同步密钥，不是加密口令。');
    if(response.status===403) throw Error('[HTTP 403] WebDAV 拒绝访问，请检查账户目录权限或服务器访问规则。');
    if(response.status===412) throw Error('[HTTP 412] 云端文件已被另一客户端修改，请重新同步。');
    if(response.status===423) throw Error('[HTTP 423] 云端文件正被另一客户端锁定，请稍后重新同步。');
    if(response.status===409) throw Error('[HTTP 409] 目标路径冲突，请检查 WebDAV 父目录存在且没有同名目录/文件冲突。');
    return response;
  }
  async diagnose() {
    // Read-only: no PUT, MKCOL, bookmark access, or encryption passphrase required.
    const r=await this.request('PROPFIND',{'Depth':'0'},undefined,this.directory);
    await r.body?.cancel();
    if(r.status===404) throw Error('[HTTP 404] WebDAV 目录不存在或账户不可见。请核对共享目录路径，不能使用 NAS 的本地磁盘路径。');
    if(r.status===405||r.status===501) throw Error(`[HTTP ${r.status}] 此地址未接受 WebDAV PROPFIND，请检查服务地址及反向代理是否允许此方法。`);
    if(r.status!==207) throw Error(`目录探测返回 HTTP ${r.status}，未取得预期的 WebDAV 207 响应，无法确认目录可用。`);
    return 'WebDAV 目录请求已收到 HTTP 207。网络连接与目录探测已完成；尚未验证写权限、同步文件或加密口令。';
  }
  async read(allowEmpty=false) {
    const r=await this.request('GET');
    if(r.status===404) return {doc:null,etag:null};
    if(!r.ok) throw Error(`WebDAV 读取失败（HTTP ${r.status}）。`);
    const reader=r.body.getReader(); let size=0; const chunks=[];
    while(true) {const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>LIMIT) {await reader.cancel();throw Error('云端文件过大。');} chunks.push(value);}
    const all=new Uint8Array(size); let offset=0; for(const c of chunks){all.set(c,offset);offset+=c.length;}
    // LOCK on a missing file may create an empty resource (RFC 4918).
    if(allowEmpty && size===0) return {doc:null,etag:r.headers.get('etag')};
    let doc; try {doc=JSON.parse(new TextDecoder().decode(all));} catch {throw Error('云端文件不是有效的加密 JSON。');}
    return {doc,etag:r.headers.get('etag')};
  }
  async write(doc,previous) {
    const lock=await this.request('LOCK',{'Content-Type':'application/xml; charset=utf-8','Depth':'0','Timeout':'Second-120'},'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>');
    if([405,501].includes(lock.status)) {
      await lock.body?.cancel();
      return this.conditionalWrite(doc,previous);
    }
    if(!lock.ok) {await lock.body?.cancel();throw Error(`WebDAV 加锁失败（HTTP ${lock.status}）。`);}
    const token=lock.headers.get('lock-token');
    await lock.body?.cancel();
    if(!token || !/^<[^<>\s]+>$/.test(token)) throw Error('服务器未提供有效的 WebDAV 锁令牌，已停止写入。');
    let wrote=false;
    try {
      const current=await this.read(lock.status===201 && !previous.doc);
      // Compare the encrypted envelope, too: a server may ignore If-Match or
      // return the same ETag for same-size changes within one clock tick.
      if(JSON.stringify(current.doc)!==JSON.stringify(previous.doc) || (previous.doc && current.etag!==previous.etag)) throw Error('[HTTP 412] 云端文件已被另一客户端修改，请重新同步。');
      const r=await this.request('PUT',{'Content-Type':'application/json','If':'('+token+')'},JSON.stringify(doc));
      await r.body?.cancel();
      if(!r.ok) throw Error(`WebDAV 写入失败（HTTP ${r.status}）。`);
      wrote=true;
    } finally {
      // Remove only our fresh empty LOCK resource after a failed first upload.
      try {if(!wrote && lock.status===201 && !previous.doc) {const r=await this.request('DELETE',{'If':'('+token+')'});await r.body?.cancel();}}
      finally {const r=await this.request('UNLOCK',{'Lock-Token':token});await r.body?.cancel();if(![204,404,409].includes(r.status))throw Error(`WebDAV 解锁失败（HTTP ${r.status}），请等待锁过期后重试。`);}
    }
  }
  async conditionalWrite(doc,previous) {
    if(previous.doc && (!previous.etag || previous.etag.startsWith('W/'))) throw Error('服务器未提供强 ETag，无法安全覆盖云端文件。请启用 ETag 支持。');
    const headers={'Content-Type':'application/json',...(previous.doc?{'If-Match':previous.etag}:{'If-None-Match':'*'})};
    const r=await this.request('PUT',headers,JSON.stringify(doc));
    if(!r.ok) throw Error(`WebDAV 写入失败（HTTP ${r.status}）。请确认文件夹存在并允许 PUT。`);
  }
}
