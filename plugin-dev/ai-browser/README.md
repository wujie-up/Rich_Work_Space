# AI 浏览器 0.1.1

工作台专用的独立 Chromium 浏览器窗口。用户通过浏览器原生地址栏、标签、前进后退和下载界面浏览，Agent 通过工作台 `desk.capabilities.v1` 操作同一组网页。浏览器业务、运行时与数据均归属此插件；Agent 的 HTML 链接通过通用视图入口对接，不修改 desk。

## 使用

在插件中心导入 `plugin-dev/dist/ai-browser-0.1.1.plg`，打开插件，点击“下载并安装 Chromium”图标。内核由包内固定版本 Playwright 1.64.1 下载至插件自己的数据目录，不含在 `.plg` 中；需要访问 Playwright 官方下载服务。安装动作只接受原生桌面操作，不会因启用插件或 Agent 调用自动下载。安装失败可重试。也可明确选择“本机 Chrome（独立资料）”并保存，使用已安装的 Chrome，无需下载。

Agent 中的本地 `.html/.htm` 文件链接需要同时升级 AI Agent 至 `0.6.128`。点击后经 `host.openView('browser-document', {path,cwd})` 交给浏览器；支持绝对路径、相对于会话工作目录的路径、中文及空格文件名。浏览器后台校验文件后以本地文件 URL 打开，保留相对脚本及样式资源；每个预览复用空白标签或新建标签，不覆盖已有网页。单实例页面同时处理首次启动参数和后续 `desk:launch` 事件，连续点击的请求按顺序处理。其他文档仍由文本编辑器打开。

本地 HTML 的打开 RPC 仅接受原生桌面直接调用；HTTP/HTTPS 导航能力仍不接受任意 file URL。不增加 Agent 工具数量或默认页面输出。0.1.1 回归测试已覆盖真实 Agent 链接渲染器经宿主连续打开两个 HTML、原有网页保留、相对资源加载及非原生调用拒绝。

输入地址并打开独立窗口。其原生浏览器界面提供多标签、导航、手动登录及下载；工作台入口显示运行状态和标签列表。内核选择保存时关闭当前浏览器。普通窗口、平铺页面与独立配置页共用公共控件及明暗主题。配置页只展示内核配置与状态。

Agent 在 AI 工作台通过工作台能力目录发现下列四个工具。AI 插件已有通用网关会将其转换为原生引擎的 MCP 工具；实际工具名由网关生成，不依赖下表的名称字符串调用。

| 能力 | 用途 | 默认返回 |
| --- | --- | --- |
| `browser.tabs.v1` | 查专用浏览器标签 | 默认 20 条 ID、标题、URL，无正文；支持 offset/limit 分页 |
| `browser.observe.v1` | 读取页面 | 交互元素与标题，最多 4000 字符 |
| `browser.act.v1` | 原生浏览器操作 | 完成步数，失败时给出失败步骤 |
| `browser.screenshot.v1` | 视觉回退 | 一张当前视口 JPEG，显式请求 |

## 节省 Agent 上下文

场景是 Agent 与人共用可见浏览器完成网站操作。主要矛盾是网页状态足够完整才能可靠操作，而整页 HTML、截图与重复正文会占用大量上下文。因此默认通过可访问结构定位，返回短元素引用；不返回 HTML、脚本、样式或整页截图。

1. `act({steps:[{op:"open",url:"https://example.com"}]})` 打开网页，取得 `tabId`。
2. `observe({tabId})` 得到精简结构、`snapshotId` 及 `ref=e...`。
3. `act({tabId,snapshotId,steps:[{op:"fill",ref:"e2",value:"search"},{op:"press",ref:"e2",value:"Enter"}]})` 批量操作，至多 12 步，仅返回简短回执。每个操作使用原生 Playwright 的可操作性等待。
4. 需要读取结果时再调用 `observe`。用 `selector` 缩小到列表、表格或结果区域；`query` 过滤行；正文使用 `mode:"text"`，完整可访问结构使用 `mode:"tree"`。
5. 默认输出 4000 字符，`maxChars` 可设为 1–12000；用 `nextOffset` 分页。分页期间页面可能变化，必须比较 `snapshotId`，变化后从头读取。
6. 轮询带 `since:上次snapshotId`，未变化时只返回 ID 与 `unchanged:true`。这是对当前请求范围的内容判定，不表示整个网页所有状态均未变化。只有需要视觉信息时调用 screenshot；默认视口 JPEG quality=45，图像原始字节上限 650000。

引用必须同时传入最近一次可访问快照的 `snapshotId`，并且指向同一标签。页面导航或后续快照会使旧引用失效；text 读取也会清除可操作快照。引用失效应重新观察，绝不根据位置或相同名称自动换一个元素。CSS selector 可用于稳定网站契约或无需快照的操作。

`act` 支持 `open/newTab/closeTab/focus/back/forward/reload/click/fill/press/select/scroll`。新标签会成为该批后续操作的目标。`select.value` 是原生 option 值，`scroll.y` 是 CSS 像素。未指定 `tabId` 时选择第一个标签，因此多标签时应显式传 ID。截图、观察与操作均不自动重试。批量操作不是事务，失败前的填表、点击、导航可能已经生效；取消只阻止后续步骤，当前原生操作可能完成。先观察再决定是否继续。

可验证指标：默认观察正文不超过 4000 字符；上限不超过 12000；未变化返回无正文；12 步以内只需一次工具调用；成功回执不包含页面结构或截图。测试夹具包含超过 40000 字符静态正文，用于比较输出字符数。字符数不等于模型 token 数，不能据此承诺固定 token 节省比例。工具 Schema 控制为四个，不按每个动作注册一个工具。

## 数据、生命周期与边界

- 数据只在 `plugin-data/ai-browser/`：`settings.json`、`engines/`、`browsers/<engine>/profile/`。两种内核分别保存登录资料，避免版本降级损坏资料；切换内核需要在对应内核重新登录。独立资料保留登录 Cookie、站点存储和浏览记录，不导入日常 Chrome 资料。关闭和升级不清除；卸载默认保留。浏览器自行管理下载的文件可能在系统下载目录，不由插件卸载删除。
- Chromium 是独立进程，macOS 仅登记当前实例实际创建的进程组。关闭先请求浏览器正常退出并等待资料落盘，再限时终止本实例进程。浏览器崩溃后工作台可重新打开。后台崩溃由既有宿主生命周期清理本实例进程，磁盘 PID 不用于杀进程。
- CDP 仅绑定随机本机回环端口，不公开给 Agent 或网页。它不是对本机恶意进程的权限沙箱。网站内容为不可信数据；工具说明明确禁止将网页指令作为用户授权。
- Agent 写操作声明 `browser.control`，沿用工作台确认与后台范围授权；读取声明 `document.read/workspace.read`。不提供任意 JS evaluate、宿主文件读写或 Cookie 导出工具。错误回执不包含填写值，日志保留调用标识和剔除网页数据后的堆栈。
- 当前仅验证 macOS。初版不包含跨设备同步、扩展市场、密码管理、反自动化绕过和 CAPTCHA 自动解答；文件上传、原生文件选择器及下载任务暂由用户在浏览器中处理。JavaScript 网页对话框默认取消，不能通过 Agent 接受确认框。只读网页可能自行产生统计等网络请求。
- 独立窗口是 Chromium/Chrome 的原生浏览器窗口；工作台中是控制入口，不是网页嵌入。没有另做一套地址栏或浏览内核。真实模型自主选择调用、原生引擎端工具发现和非 macOS 平台需要单独验证，不与宿主能力调用通过混称。

## 构建与验证

在仓库根目录运行 `npm run build`（自动发现此插件），或只构建插件：`npm --prefix plugin-dev/ai-browser run build`。
生成包：`npm run pack:plugin -- plugin-dev/ai-browser/dist/package`。
领域测试：`node --test plugin-dev/ai-browser/test/*.test.js`。
UI/宿主验收脚本放在 `test/electron/`，使用临时数据目录，不修改真实登录资料。构建包包含固定版本 Playwright 控制运行时及许可证，不依赖开发机 node_modules。浏览器引擎通过用户点击安装，不随构建下载或混入插件包。

2026-11-02 在 macOS 实际验证：真实 Chromium 交互、短引用与页面跳转失效、失败停止后续步骤、取消前不执行、站点数据重开保留、截图大小限制；真实宿主独立 worker 加载与能力发现/调用、写操作确认、切换内核与 Agent 操作互斥、后台崩溃后仅回收所属浏览器且另一插件仍可操作；Electron 工作台明暗主题、340/900 宽窗口、键盘帮助与轮询焦点保留、普通页面和配置页面。未修改宿主源码。

`node plugin-dev/ai-browser/test/install.manual.mjs` 已在全新临时目录完成真实 Chromium 在线下载、安装和首次打开本地夹具网页，用时约 37.5 秒；结束关闭浏览器并清理测试目录。该脚本依赖网络，不纳入离线领域测试。`dist/verification/installation.json` 保留实际结果，`dist/verification/*.png` 保留界面截图。

token 相关夹具实测：可见正文 48045 字符，默认交互观察 164 字符；此结果只反映该夹具的输出字符数，不代表所有网站或模型的 token 消耗。Agent 操作与内核切换共用宿主资源锁；并发冲突返回 RESOURCE_BUSY，状态查询仍保持可用。
