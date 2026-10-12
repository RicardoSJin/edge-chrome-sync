# AGENTS.md

桥同步 · Edge & Chrome：一个 Chrome / Edge Manifest V3 扩展，通过用户自己的 HTTPS WebDAV 目录同步收藏夹、7 项隐私开关和 3 项网页字号。数据在本地用独立加密口令做端到端加密，云端只有一个密文文件 `bridge-sync-v1.enc.json`；不需要注册账户，也不经过开发者服务器。目前仍是预发布（README 写明：v1.0.3 在 Windows Edge 上的实际合并效果尚未验证）。

## 技术栈与约束

- 纯 JavaScript（ES Module），**无依赖、无构建步骤**；仓库根目录就是可以直接"加载已解压的扩展程序"的扩展目录
- 最低 Chrome 120（`manifest.json` 的 `minimum_chrome_version`）；测试和 CI 用 Node.js 24
- 加密只用 Web Crypto（`crypto.subtle`），不引入第三方加密库
- 界面文字、报错信息和 README 都是中文；代码注释是英文

## 目录结构

| 文件 | 作用 |
|---|---|
| `manifest.json` | 必需权限：`storage`、`bookmarks`、`alarms`；可选权限：`privacy`、`fontSettings`、`https://*/*`（运行时只申请用户填写的那个站点）；CSP `script-src 'self'; object-src 'none'`；没有内容脚本 |
| `background.js` | Service worker：配置保存、同步流程、备份 / 恢复、中断标记、闹钟、收藏夹和设置变更监听、消息分发 |
| `core.js` | 纯函数，不调用 `chrome.*`：加密 / 解密、地址校验（`endpoint`）、数据校验（`validateData` / `validateDoc`）、胜出规则（`winner`）、收藏夹合并（`mergeBookmarks`）、内容哈希 |
| `browser.js` | 浏览器 API 适配：收藏夹根目录识别（`roots`）、读取（`capture`）、写入前检查（`preflight`）、写入（`apply`）、释放设置控制（`releaseSettings`） |
| `dav.js` | `WebDAV` 类：请求封装与错误分类、连接检测（`diagnose`）、读取、加锁写入、条件写入 |
| `options.html` / `options.js` / `options.css` | 设置页（`options_page`，点击工具栏图标打开）；`options.css` 是一整行压缩样式 |
| `icons/` | 16 / 32 / 48 / 128 图标（由 `build.ps1` 生成后提交） |
| `tests/*.test.js` | `node:test` 单元 / 集成测试，用模拟的 `chrome` 和 `fetch`，不访问真实服务器 |
| `tests/preview-server.js` | 只看界面用的本地预览服务器，不进安装包 |
| `build.ps1` | 打包脚本（PowerShell，用到 `System.Drawing`，只能在 Windows 上跑） |
| `.github/workflows/test.yml` | push / PR 时跑测试 |
| `README.md` / `PRIVACY.md` / `LICENSE` | 面向用户的中文说明、隐私说明、MIT 许可；三者都会打进安装包 |

`dist/`、`*.zip`、`VALIDATION.md`、`bridge-backup-*.json`、`CONNECTION-CHECK-*.md`、`bridge-sync-v1.enc.json`、`.env*` 都在 `.gitignore` 里，可能含个人数据，不要提交。

## 常用命令

| 用途 | 命令 |
|---|---|
| 测试（全部 13 项） | `npm test`（即 `node --test tests/*.test.js`，无需安装依赖） |
| 只跑 CI 用的那部分（10 项） | `node --test tests/core.test.js tests/integration.test.js tests/browser.test.js` |
| 界面预览（模拟后台，不碰真实收藏夹和服务器） | `node tests/preview-server.js` → 打开 `http://127.0.0.1:8766/`，Ctrl+C 结束 |
| 打包（Windows，本机没有 PowerShell，未实测） | `powershell -File build.ps1`：先跑测试 → 重新生成图标 → 检查 manifest 引用的文件 → 输出 `dist/edge-chrome-sync-v<版本>.zip` |
| 打包（macOS，不重新生成图标；已验证生成的文件列表和内容与发布的 v1.0.3 包完全一致） | `npm test && v=$(node -p "require('./manifest.json').version") && mkdir -p dist && rm -f dist/edge-chrome-sync-v$v.zip && zip -X -r -D dist/edge-chrome-sync-v$v.zip manifest.json background.js browser.js core.js dav.js options.html options.css options.js icons README.md PRIVACY.md LICENSE -x '*.DS_Store'` |
| 生成校验文件 | `cd dist && shasum -a 256 edge-chrome-sync-v$(node -p "require('../manifest.json').version").zip > SHA256SUMS.txt` |

打包只包含 `build.ps1` 里 `$files` 列出的文件；新增运行时文件时，`build.ps1` 和上面的 macOS 命令都要加上。

## 本地调试

1. `chrome://extensions`（或 `edge://extensions`）开启开发者模式 →"加载已解压的扩展程序"→ 选仓库根目录
2. 改代码后在扩展页点"重新加载"；service worker 日志在扩展卡片的"Service Worker"检查器里看
3. 重新加载后，只保存在会话里的加密口令会丢失，要重新填写
4. 用**测试用的 WebDAV 目录和少量测试收藏夹**调试，不要直接拿真实收藏夹试。`chrome.storage.local` 里有明文的 WebDAV 密码、可能还有加密口令和明文备份，查看存储时不要把内容贴进 issue 或日志
5. 只改界面时用 `tests/preview-server.js`：它给 `options.html` 注入一个模拟的 `chrome` 对象，只模拟 `load` / `save` / `clearPass`，其他操作直接返回错误

## 架构要点

- **本地状态**（`chrome.storage.local`）：
  - `config`：`{url, username, password, groups, interval, auto, remember, consent}`，WebDAV 密码明文保存
  - `state`：`{device, records, initialized}`；`records[类别] = {data, time, device, hash}` 是上次同步的快照，`initialized[类别]` 表示这个类别是否已完成首次同步
  - `backups`：最多 5 份明文备份 `{id, time, reason, data}`
  - `journal`：`{backupId, time}`，表示"本地写入进行中"；存在时拒绝同步和保存配置，只能先恢复备份
  - `status`：最近一次结果，显示在设置页
  - `changed_bookmarks` / `changed_privacy` / `changed_fonts`：最近一次收到浏览器变更事件的时间
  - `pass`：只有勾选"在此设备记住"时才写入（明文）；默认口令只放在 `chrome.storage.session` 的 `pass`
- **类别**：`bookmarks`、`privacy`、`fonts`，各自是一份独立的整类快照。收藏夹格式为 `{bar, other, mobile}`，节点只有 `{title, url}` 或 `{title, children}`（不含 id、添加时间）；隐私和字号只读取 / 写入"可被本扩展控制"的项
- **云端文档**（加密前）：`{version: 1, groups: {类别: {time, device, data}}}`。写回时以云端已有的 `groups` 为底，所以本机没勾选的类别不会被覆盖
- **同步流程**（`background.js` 的 `sync()`）：
  1. 等待尚未写完的变更时间戳；有 `journal`、未确认规则、缺站点权限或缺口令时直接报错
  2. 读取本地各类别并计算 SHA-256；与 `records` 不同就生成新记录，时间取"变更事件时间（没有则取当前时间）"与"上次时间 + 1"中较大的，**联网前先保存**，避免重试时刷新时间
  3. 读取并解密云端，`validateDoc` 校验
  4. 逐类别决定胜者：未初始化的类别云端优先；已初始化的按 `time` 比较，**相等时以云端为准**（`winner`）。收藏夹在"首次同步"或"手动合并"（`mergeOnly`）且云端有数据时改走 `mergeBookmarks`
  5. 对需要改动本地的类别先 `preflight`，再检查同步期间本地有没有变化（`generation` 计数器 + 重新读取比对哈希），有变化就停止
  6. 需要改本地或合并后需要写云端时，先存一份本地备份
  7. 先加密写云端，再写本地：写本地前设置 `journal`，写完再读一遍核对哈希，一致才更新 `records` / `initialized` 并删除 `journal`
- **收藏夹合并规则**（`core.js` 的 `mergeBookmarks(remote, local)`）：在 `bar` / `other` / `mobile` 三个根目录内分别合并；保留云端顺序，再追加本地独有的条目。同一层里收藏用"标题 + URL"、文件夹用"标题"作为键，相同键按出现次序一一配对：配对的文件夹递归合并，配对的收藏去重，没配上的追加。不同层级或标题不同但 URL 相同的收藏都保留。合并结果是幂等的（再合并一次不变）
- **首次同步的触发**：第一次保存配置、修改 WebDAV 地址或账户时，清空所有类别的 `initialized` / `records`；新勾选某个类别时只清空这个类别
- **加密**（`core.js`）：PBKDF2-HMAC-SHA-256 600,000 次派生 AES-256-GCM 密钥，每次加密随机 16 字节盐和 12 字节 IV，附加认证数据为 `bridge-sync-v1`。密文信封 `{format: 'bridge-sync-v1', kdf: 'PBKDF2-SHA256', iterations: 600000, salt, iv, data}`（Base64）。解密时要求这些字段**完全一致**，解密失败统一报"口令不匹配或云端文件已损坏"。口令至少 12 个字符
- **大小限制**：明文最大 8 MiB，下载 / 密文最大 16 MiB；收藏夹最多 50,000 个节点、64 层，标题 ≤ 10,000 字符，URL ≤ 100,000 字符且必须带协议；字号为 0–100 的整数；云端时间不能晚于本机时间 5 分钟以上
- **WebDAV 交互**（`dav.js`）：
  - 地址必须是 HTTPS 目录，不能带账户、查询参数和片段，末尾自动补 `/`；只读写目录下的 `bridge-sync-v1.enc.json`；Basic 认证
  - 每个请求都是 `redirect: 'manual'`、`credentials: 'omit'`、`cache: 'no-store'`，20 秒超时
  - 连接检测：对目录发 `PROPFIND Depth: 0`，必须返回 207；只读，不需要加密口令
  - 读取：`GET`，404 视为云端为空；流式读取，超过 16 MiB 立即中止
  - 写入：先 `LOCK`（独占，`Timeout: Second-120`）→ 重新读取，云端密文或 ETag 和同步开始时读到的不一致就报 412 → 带锁令牌 `PUT` → `UNLOCK`（204 / 404 / 409 都算成功）。首次上传失败时，删除 `LOCK` 刚创建（201）的空文件
  - 服务器对 `LOCK` 返回 405 / 501 时改用条件写入：已有文件用 `If-Match`（必须是强 ETag，弱 ETag 或没有 ETag 直接拒绝写入），没有文件用 `If-None-Match: *`
  - 默认 `fetcher` 必须写成 `(...args) => globalThis.fetch(...args)`，不能把 `fetch` 存成对象方法再调用（v1.0.2 修过的 Illegal invocation；`tests/dav.test.js` 有覆盖）。测试通过构造函数第二个参数注入假的 `fetch`
- **调度**：闹钟 `periodic` 按 5 / 15 / 30 / 60 分钟周期触发；收到任何变更事件后重建闹钟 `changed`（约 30 秒后触发）。两者都只在 `config.auto` 为真时同步。`onInstalled` / `onStartup` 时重建 `periodic`。清除口令、恢复备份、释放设置控制都会关闭自动同步并清除两个闹钟
- **变更监听**：6 个收藏夹事件、7 项隐私设置的 `onChange`、3 项字号的 `on…Changed`。扩展自己写入期间（`applying`）忽略事件
- **并发**：除 `load` 外，所有消息和闹钟都经过 `locked()`；已有操作在跑时**直接拒绝**（"已有操作正在进行"），不排队
- **消息**：设置页通过 `chrome.runtime.sendMessage({action, ...})` 调用后台，`action` 为 `load`、`save`、`diagnose`、`sync`、`mergeBookmarks`、`clearPass`、`restore`、`release`、`exportBackup`。只接受来自本扩展 `options.html` 的消息；返回 `{ok, data}` 或 `{ok: false, error}`
- **权限申请**：`chrome.permissions.request` 只在 `options.js` 的用户点击（保存配置、检测连接）里调用；后台只用 `permissions.contains` 检查，缺权限就报"[站点权限缺失]"
- **备份与恢复**：每次覆盖本地或合并前自动备份，最多保留 5 份。恢复前会先备份当前数据，并固定保留被恢复的那一份；恢复后自动同步暂停，被恢复类别的记录时间设为"当前时间"与"上次时间 + 1"中较大的，并标记为已初始化
- **收藏夹写入**（`browser.js` 的 `apply`）：先把新条目全部建好，再删除旧条目；建到一半失败会删掉已建的新条目，原有收藏不受影响。删除阶段中断时保留 `journal`，等用户恢复
- **错误处理**：所有错误都是带中文提示的 `Error`；网络类错误带 `[HTTP 401]`、`[连接超时]`、`[网络连接失败]`、`[地址重定向]`、`[站点权限缺失]` 等前缀。后台把错误写进 `status` 并返回给设置页。测试用正则匹配了不少提示文字，改文案时要同步改测试
- **配置迁移**：设置页"复制配置"导出 `{format: 'bridge-connection-v1', config}`，去掉 WebDAV 密码、加密口令、`remember`、`consent`；导入时 `auto` / `remember` / `consent` 一律重置为 false
- ❓ `boot()` 里调用了 `chrome.storage.local.setAccessLevel(...)`，浏览器是否支持对 local 存储调用这个方法未验证；如果抛错，后面重建 `periodic` 闹钟的代码不会执行

## 安全约束（不要放宽）

- 只允许 HTTPS WebDAV 地址；不跟随重定向（防止把 `Authorization` 转发到别的地址）；不忽略证书错误；不执行 `MKCOL`；请求不带浏览器 Cookie（`credentials: 'omit'`）
- 主机权限只按用户填写的站点运行时申请，不要改成安装时就申请 `https://*/*`；`privacy` / `fontSettings` 保持可选权限；不加内容脚本
- 加密口令只在本地派生密钥，**绝不写进云端文件、复制的配置、日志或错误信息**；默认只存会话存储。WebDAV 密码同样不进复制的配置
- 网络错误提示不能带出底层异常文字（测试检查过 `private-detail` 不会出现在提示里）
- 写入任何数据前必须先解密并通过 `validateDoc` / `validateData`；解密失败或校验不过时不能覆盖本地或云端
- 写云端必须有冲突保护：有锁时加锁并复查，没锁时用强 ETag 条件写入；发现冲突就报错，不能回退成无条件 `PUT`
- 覆盖本地前必须先备份；收藏夹"先建后删"；有 `journal` 时禁止继续同步。本地存储配额不足时停止，不能跳过备份硬写
- 受企业策略或其他扩展控制的设置、普通根目录里的受管理收藏夹、非空且无法识别的根目录、重复的根目录（账户与本地双份）一律拒绝，不要绕过（受管理的根目录本身直接跳过）
- 只碰 WebDAV 目录里的 `bridge-sync-v1.enc.json`；`DELETE` 只用于清理本次 `LOCK` 刚创建的空文件
- 只接受来自本扩展 `options.html` 的消息；CSP 不放宽，不用内联脚本；设置页用 `textContent` 渲染内容
- `FORMAT`、文件名、`ITERATIONS`、附加认证数据、`version: 1` 都是云端文件格式的一部分：修改任何一个都会让已有云端文件无法解密。确实要改时，必须新增格式版本并提供迁移，不能直接改常量

## 开发流程

- 目前所有提交都直接在 `main` 上，没有分支或 PR 记录（3 个提交，`gh pr list` 为空）；提交说明用英文一句话概括（如 `Fix native fetch invocation and protect WebDAV writes with locks`）
- 每个版本一个提交：代码 + 测试 + `README.md` + `manifest.json` 的 `version` 一起改
- 发布流程（根据历史推断）：改 `version` → 更新 README（"当前状态"一节和安装步骤里的版本号、测试数量）→ `npm test` → 打包 → 生成 `SHA256SUMS.txt` → 打标签 `v<版本>` → 创建 GitHub Release 并**标记为预发布**，上传 `edge-chrome-sync-v<版本>.zip` 和 `SHA256SUMS.txt`（v1.0.1 只有 ZIP）
- 发布说明用中文，写明改动、测试数量、尚未验证的部分、升级方式（覆盖原加载目录后"重新加载"，不要先卸载），以及"GitHub 插件下载器"的配置：勾选"包含预发布版本"、包名规则 `edge-chrome-sync-*.zip`。所以 **ZIP 文件名格式不要改**
- CI（`.github/workflows/test.yml`）只跑 `core` / `integration` / `browser` 三个测试文件，**没有跑 `tests/dav.test.js`**（❓是否有意）；本地发布前用 `npm test` 跑全部测试。新增测试文件时要同时加进 workflow
- 修改行为时同步更新 `README.md`（用户说明）、需要时更新 `PRIVACY.md`，以及相应测试

## 编码风格

- 保持现有的紧凑写法：短函数、长单行、少空格少空行、不引入框架和依赖；两空格缩进
- 分层：纯逻辑放 `core.js`（可在 Node 里直接测）；`chrome.*` 适配放 `browser.js`，回调式 API 统一用 `api()` 包装成 Promise（测试按回调形式模拟）；流程编排放 `background.js`；网络放 `dav.js` 并保持 `fetcher` 可注入
- 新的同步逻辑要在 `tests/integration.test.js` 里补端到端用例（它用内存存储和假 `fetch` 加载真实的 `background.js`，通过 `onMessage` 监听器驱动）
- 面向用户的提示写中文，说明原因和下一步该怎么做；代码注释写英文，解释安全上的考虑
