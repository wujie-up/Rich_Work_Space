# Rich_Work_Space 插件开发规范

核对日期：2026-10-24；依据当前仓库实际清单校验、worker、页面桥接和打包实现。

适用宿主：DeckPg 0.1.8（保留 Work Desk 数据目录），插件 API 2、dataVersion 1。读者包括插件开发者和接手实现的 AI。
接口详细表见 [插件 API](plugin-api.md)，服务管理与旧 Adapter 升级见 [MCP 使用说明](mcp-plugins.md)，服务代码与配置声明见 [MCP 服务开发与部署规范](mcp-service-development.md)。

## 目标和边界

这是一个桌面宿主加载独立能力的场景。主要矛盾是插件需要共享桌面和互相协作，但不能把业务耦合进宿主，也不能因单个插件故障拖垮其他插件。
因此桌面只负责窗口、通用 RPC、服务发现和生命周期；业务全部在插件内。独立后台进程负责故障隔离，独立站点 frame 负责页面隔离，版本化服务契约负责协作。
验证标准：空桌面可用；一个插件崩溃后桌面与其他插件可用；停用只回收目标实例的任务；保留数据重装可以继续读取原配置和历史。

新增显示属性适用 DeckPg 0.1.19 及以上版本。

当前只接纳可信本地插件。安全权限协议、签名和市场审核暂不实现，详见末尾边界说明。

## 三种类型与显示、运行属性

| type | 用途 | 页面与图标 | 后台 |
|---|---|---|---|
| application | 用户操作的应用，例如 AI、MCP 管理 | 可有页面；图标可隐藏 | none / task / service |
| service | 给其他功能提供能力 | 无工作空间页面、无桌面图标；可有配置页 | none / task / service |
| resource | 静态文件，例如供消费方使用的图片、样式 | 无工作空间页面、无桌面图标；可有配置页 | 只能 none |

类型描述用途，其他属性单独声明：

| 属性 | 值与实际效果 |
|---|---|
| singleInstance | 布尔值，默认 false；由插件清单声明且新包必须显式填写；true 时复用已有界面，隐藏新建窗口菜单并忽略顶部标签双击；false 时双击顶部标签新建窗口 |
| showIcon | 布尔值；控制桌面侧栏图标，隐藏不等于禁用，应用仍可从插件中心打开 |
| loadOnStartup | 布尔值；启用的 service 后台为 true 时随宿主启动/启用/安装激活，为 false 时第一次 RPC 激活 |
| background | none 不创建后台；task 首次 RPC 启动、全部并发 RPC 完成后退出；service 激活后持续到停用/退出/故障 |
| type | application / service / resource，决定是否允许工作空间界面 |

约束：service/resource 的 showIcon 必须 false 且不能声明工作空间 views（独立 settings 配置页除外）；resource 的 background 必须 none；none 不能有 main；task 必须 loadOnStartup:false，不能发布持久服务。
none 的 loadOnStartup 不执行代码、不创建进程，资源按访问读取。task 没有定时器或启动任务调度接口，只能由调用触发。
旧 API 2 清单缺失属性时默认 application、true、true、service，保持原有行为。新包应显式写全，旧宿主不支持这些新语义。

工作台顶部标签显示插件名称，插件外壳不提供最大化、最小化及独立标题控制栏；普通插件内容直接铺满标签下方工作空间，不保留外框、留白或外层拖动缩放，标签与内容之间不画横向分隔线。AI Agent、文本编辑器、工作流声明 `singleInstance:false`；MCP、Agent 抓包和资源监控声明 `singleInstance:true`。资源监控继续使用独立悬浮面板。此属性不改变共享后台、授权、配置与历史的数据归属。

当前源码插件：AI Agent 0.3.0 与 MCP 0.4.0 均为 application / true / true / service；文本编辑器 0.1.3 为 application / true / false / service。MCP 已内置 AI 接入，不再需要独立 Adapter 图标或包。

## 包结构和清单

```text
example/
  plugin.json
  src/main/common/index.mjs
  src/main/os/mac/           # 仅确有平台差异时添加
  src/resource/index.html
  test/
  build/                    # 有构建需求时添加
  dist/                     # 构建输出
```

```json
{
  "id": "example-app",
  "name": "Example",
  "version": "1.0.0",
  "apiVersion": 2,
  "dataVersion": 1,
  "type": "application",
  "showIcon": true,
  "loadOnStartup": false,
  "background": "service",
  "closeDescription": "关闭工作区，保留已保存的数据。",
  "main": "src/main/common/index.mjs",
  "views": [{"id":"main","title":"Example","entry":"src/resource/index.html"}]
}
```

ID 为 `[a-z][a-z0-9-]{0,63}`，发布后保持稳定；数据归属靠 ID，改名不应改 ID。所有入口都必须存在且位于包内。

### 关闭确认说明

普通窗口默认命名为“窗口1、窗口2”，仅按同一插件当前开启窗口独立编号，保留用户自定义窗口名。同插件有多个窗口时，顶部标签的“关闭窗口”只移除当前窗口，其他窗口及共享后台继续运行。关闭最后一个窗口才进入下述插件关闭确认与停止流程；取消时保留窗口和任务。

插件通过清单 `closeDescription` 提供关闭说明，宿主不编写插件业务描述。新插件必须提供一句简短、准确的纯文本，建议不超过 40 字，协议上限 240 字；说明正常关闭会停止什么，以及哪些数据会保留。不要重复“是否确认”、按钮名称、通用操作步骤，也不要承诺尚未实现的自动保存。

例如 AI 插件可写“关闭并归档会话，保留配置和历史。”，MCP 插件可写“停止 MCP 服务，保留连接配置。”。说明经 `plugins.preview` 的同名字段传给宿主，只作为文本展示，禁止 HTML。旧插件缺失此字段时不展示业务说明，仍可关闭。

实际受影响任务由 `context.lifecycle.register({ snapshot, stop })` 提供，宿主在有任务时列出任务；没有任务时不显示空列表提示。宿主负责取消、关闭、强制关闭等通用交互，插件不提供按钮标签、不替代确认流程，也不控制强制关闭。强制关闭入口必须在插件卡死、预览未返回时保持可用，提示可能丢失未保存内容。
后台 `.js` 使用 ESM 时，包内 package.json 声明 type:module，或直接用 `.mjs`。
views 是预先声明的窗口，适合无后台和按需后台应用。持续后台也可在 activate 中通过 views.register 注册窗口；已运行时使用运行实例的视图列表。
打开页面本身不激活按需后台，页面调用第一个后台方法时才激活。没有声明视图的按需应用无法先打开页面。

无界面服务将 type 改为 service、showIcon 改为 false，删除 views；需被自动发现时使用 background:service、loadOnStartup:true。
资源包设 type:resource、showIcon:false、background:none，删除 main 和 views，保留 loadOnStartup 布尔值。
资源可按 `desk-plugin://<插件ID>/<相对文件>` 读取，但宿主尚未提供通用主题、菜单、默认桌面布局声明解释器；资源包安装不代表自动应用样式。capabilities 也只是说明性元数据，不是权限或自动接线机制。

## 后台实现与生命周期

```js
export function activate(context) {
  context.methods.register('example.echo', value => ({ value }));
  context.lifecycle.register({
    snapshot: () => [],
    stop: async reason => { console.info('[example:stop]', { pluginId: context.pluginId, reason }); }
  });
}
export async function deactivate() {}
```

activate/deactivate 都必须导出。注册方法应在 activate 完成前结束。初始化失败会尝试清理；方法报错应带可识别 code 和可读 message。
持续后台的任务应登记在 snapshot，stop 负责关闭、归档；deactivate 释放剩余监听器和连接。不能依靠页面关闭事件保存重要历史。
需要子进程时使用可执行文件及参数数组，登记当前实例拥有的进程组父 PID 到 context.ownProcesses；更新时提交当前完整列表。禁止根据历史存储的 PID 杀进程。

一次性任务使用 background:task、loadOnStartup:false。必须等待全部业务工作结束才返回 RPC，不能启动未等待的后台任务。
并发调用共享一个实例，最后一个调用结束后执行 stop('task-complete')、deactivate 并回收进程；清理阶段新调用会得到 PLUGIN_BUSY，调用方可稍后重试。错误路径也会回收。
需要持久订阅、对外服务或长时间驻留的任务应选择 service 模式。故障会禁用插件，重新启用后才可继续。

数据读写示例：

```js
const key = `plugin-data/${context.pluginId}/settings.json`;
const settings = await context.storage.readJson(key, {});
await context.storage.writeJson(key, settings);
```

Storage 使用宿主 userData 内相对路径，提供 readJson/writeJson/path；path 返回文件绝对路径供后台使用。
macOS 默认根目录为 `~/Library/Application Support/Work Desk`。只写自己的 plugin-data/ID，不读取或改写别的插件内部文件。
Storage 不是恶意代码权限沙箱。配置更新需要考虑多个页面同时读写旧快照，关键写入使用 exclusive 方法及重新读取合并。
日志包含插件 ID/任务 ID，不输出令牌、环境变量或凭据；编辑器等文档类插件也不记录正文。

重要草稿应在编辑过程中持续保存，而不是只在 stop/deactivate 时保存。强制退出、进程崩溃、系统关机均可能中断清理回调；不能承诺强制关闭时仍能执行最后一次保存。

运行依赖必须随包提供或构建到产物中。context.importModule 只解析宿主已经提供的依赖，不负责安装 npm 包，也不保证任意版本可用。
本机模块需要匹配宿主 Electron ABI 和目标系统，不能把开发机 Node 二进制当作跨平台产物。

## 页面接入协议

页面运行在 `desk-plugin://<ID>/` 的沙箱 iframe，无 Node。不要直接访问桌面 DOM，也不要要求任意 Electron IPC。
最小桥接示例（生产代码应补充超时、卸载清理和事件订阅）：

```js
let sequence = 0;
const pending = new Map();
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== 'desk-host://desktop') { return; }
  const message = event.data;
  if (message?.type !== 'desk:result') { return; }
  const request = pending.get(message.id);
  if (!request) { return; }
  pending.delete(message.id);
  if (message.error) { request.reject(Object.assign(Error(message.error.message), message.error)); }
  else { request.resolve(message.value); }
});
function invoke(method, ...args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ type: 'desk:invoke', id, method: 'plugin.invoke', args: [method, args] }, 'desk-host://desktop');
  });
}
const result = await invoke('example.echo', 'hello');
```

完整实例参照 `plugin-dev/ai-agent/src/renderer/api.js`。后端 RPC 参数/返回值必须可通过 IPC 序列化；每次 RPC 有期限，默认 30 秒。
宿主绑定页面所属插件，页面不传 pluginId。plugin.invoke 的 args 必须为 `[方法名, 参数数组]`，例如 `args: ['example.echo', ['hello']]`；不能平铺业务参数。除 plugin.invoke 外可请求 host.chooseDirectory 和 storage.getPreferences。
事件为 desk:event（pluginId/channel/value），主题为 desk:theme（theme）；只处理来自父窗口且 origin 匹配的消息。
沙箱未开放原生表单提交和模态对话框；使用 type=button、页面内表单处理、页面内错误提示。

插件负责内容随窗口尺寸变化适配，可用 CSS/ResizeObserver。侧栏占宽度，桌面工作区变化不应重启插件后台或重新创建插件页面。
需要整页等比例缩放时由插件实现，包括字体、终端适配和必要留白；宿主不注入业务布局规则。支持多开时每页独立 UI 状态，后台配置与任务仍由稳定插件 ID 管理。

## 插件之间的协作协议

禁止导入其他插件内部源码。发布版本化契约，并通过通用服务发现协作：

```js
// 提供方 activate 内
context.methods.register('example.resolve', input => ({ version: 1, value: input.key }));
context.services.register({ contract: 'example.resolve.v1', method: 'example.resolve' });
// 消费方已注册 RPC 的 handler 内（不能在 activate 中调用发现）
const providers = await context.services.discover('example.resolve.v1');
const result = await context.services.invoke(providers[0], { key: 'demo' }, { timeout: 3000 });
```

消费方必须自行处理无提供方、多提供方和结果版本不兼容；示例省略选择 UI。
发现只返回当前启用且已运行的后台，不会自动激活按需提供方。调用只能发生在有效 RPC 上下文；宿主校验真实调用者、公开方法、截止时间，拒绝循环和超过八跳的链。
同一插件内部直接调用领域对象，不走跨插件循环。task 后台不能发布持久服务。
MCP 同时提供 mcp.connections.v1 与 agent.launch-config.v1；AI 消费后者，选择失效时阻止新的 Codex 启动，已运行会话不热更新。详细字段见 API 文档。

## 构建、打包与升级

仓库内插件若使用 renderer 构建约定，在清单声明 renderer 为源码入口，HTML 放 src/resource/index.html，构建输出 dist/renderer。
第三方插件也可以自带构建结果，宿主只识别 main 和 views entry，不运行安装脚本。

```sh
npm run build
npm run pack:plugin -- plugin-dev/mcp
# 默认输出 plugin-dev/dist/<ID>-<version>.plg
# 自定义文件名仍输出到统一分发目录
npm run pack:plugin -- plugin-dev/mcp plugin-dev/dist/mcp.plg
tar -tzf plugin-dev/dist/mcp.plg
```

.plg 是标准 gzip tar，根目录直接包含 plugin.json；不是 ZIP，也不要多套一层目录。包应包含运行所需全部文件，不能包含链接、越界路径或特殊文件。
当前上限是 10000 条目、展开 512 MiB。apiVersion 必须 2、dataVersion 必须 1，不支持自动数据版本迁移。
升级流程：停止任务 → 在插件中心保留数据卸载 → 用户导入同 ID、兼容数据版本新版 → 验证原配置和历史。
宿主升级不自动覆盖已安装的插件，新插件产物交给用户自行导入。

## 开发验收与 AI 交接

交付至少记录实际命令、结果、平台与未覆盖项：

- 清单非法组合与入口越界能被拒绝；图标隐藏不影响插件中心管理。
- none 不创建后台，按需后台首次调用激活，并发首次调用只启动一个实例；task 成功和失败后均回收。
- 空桌面、后台异常/超时、页面崩溃后宿主和其他插件仍可操作；清理仅影响当前实例登记的进程。
- 保留数据卸载重装与重启后能读取配置和历史；多个窗口不互相覆盖旧配置。
- 服务无提供方、多个提供方、停用、循环、超时和版本不兼容均有明确结果。
- 在实际打包的 macOS 应用中完成一次安装、打开、调用、停止验证，不能用源码单测代替安装包验证。

给 AI 的任务模板：明确修改插件目录、type/四项属性、RPC/服务契约、数据文件及兼容方式、窗口行为、目标平台和验收命令。要求先读 AGENTS.md 与本指南；禁止业务进入 desk、跨插件内部导入、自动安装用户插件、未经授权提交代码。范围外问题先报告，不能顺手修复。

## 安全协议的后续边界（本次不实现）

现有协议包含清单版本、包路径检查、归属绑定 RPC、独立进程、独立站点与超时。这些用于兼容与故障隔离，不等于限制可信 Node 后台访问文件或网络。
当前没有插件签名、细粒度文件/网络权限审批、依赖信任链或市场审核。
后续如接纳不可信插件，应单独设计：权限声明与用户授权协议、宿主能力白名单、进程系统级沙箱、包签名/撤销与升级验证、凭据代理和审计。
不要在现有 capabilities 字段写入权限并声称已受保护，也不要把独立进程当作安全保证。


## 从零开发的最短流程

1. 阅读根目录 AGENTS.md、本规范和 API 文档，明确插件领域与稳定 ID；不把插件专用方法加入 desk。
2. 选择 type、showIcon、loadOnStartup、background，并列出页面、RPC、数据文件和运行依赖。
3. 在 plugin-dev/<领域>/ 建立清单、实现和测试。页面只通过允许的桥接访问后台；不复制其他插件的业务实现。
4. 声明数据格式与兼容规则。多个页面共同修改的数据由后台串行处理，不能用陈旧的整份配置覆盖新配置。
5. 编写领域单测和独立临时目录中的真实宿主验收；不能借用用户当前数据目录测试卸载、异常或数据迁移。
6. 构建最新资源、检查入口、生成新版本 .plg、检查归档并在临时宿主中导入验证。
7. 交付文档、包路径、版本、实际验证结果、未覆盖项和运行前提。插件由用户自行安装；未经授权不提交代码。

推荐在插件目录附带 title.md（用途与操作说明）、test/、依赖及许可证说明。使用宿主已提供依赖之外的库时，将运行代码打包入产物或随包交付；不能依赖开发机的 node_modules 路径。

## 文档及预览类插件的附加约束

- 格式化先解析和校验，失败显示可读错误并保留原文；不能把失败结果覆盖文件或草稿。
- 文件保存应处理取消、读写失败和外部变更；明确编码、换行及支持的文件大小，不默默截断。
- 打开、保存和预览都是插件领域行为。宿主提供目录选择与受控文件选择；写入与保存属于插件。不得绕过桥接访问宿主文件系统。
- Markdown 和绘图结果按不可信内容处理：清洗 HTML，禁用脚本、危险 URL 和可执行事件；不因预览执行任意代码。
- 联网渲染、图片和外部资源请求应明确说明，默认不将文档正文、凭据或本地文件发送到第三方。
- 渲染耗时任务应可取消或有期限；输入更新后，旧渲染结果不能覆盖较新的预览。
- 只在实际验证后声称支持格式或绘图类型，语法高亮、格式化和渲染是不同能力，不得混用描述。

## 发布交付记录模板

```text
插件：<名称 / 稳定 ID / 版本>
宿主：<版本>；平台：<实际系统和架构>
属性：type / showIcon / loadOnStartup / background
产物：<.plg 绝对路径>；SHA-256：<实际校验值>
构建：<命令、退出状态>
测试：<命令、通过数量及实际覆盖能力>
真实宿主验收：<临时数据目录、导入、打开、操作、停止和重装结果>
兼容性：<数据版本、是否保留旧数据、迁移方式>
前提及未覆盖：<外部运行时、网络依赖、未验证平台或能力>
代码提交：未提交（除非用户另外授权）
```

## 开发目录与手工解压安装

开发源码位于 `plugin-dev/<领域>/`，交付文件位于 `plugin-dev/dist/`，两者均不作为用户运行时安装目录。
macOS 安装目录为 `~/Library/Application Support/Work Desk/plugins/<pluginId>/`；使用自定义 `--desk-data` 时，以该数据目录为根。
将 `.plg` 作为 gzip tar 解压到以插件 id 命名的目录（目录下直接包含 `plugin.json`），重启桌面即可发现。
桌面会校验入口文件、符号链接、路径边界及新版包的 `integrity.json`，损坏包不会执行。旧包仅进行结构校验；哈希清单用于检查完整性，并不证明发布者身份。
同 id 已禁用的插件在重启后保持禁用。更新前通过桌面卸载并选择保留数据，再导入新包；不要在插件运行中覆盖安装目录。配置和历史始终属于 `plugin-data/<pluginId>/`。

## AI 工作台能力与固定图标（0.1.8）

主要矛盾是能力需要统一协作，而业务与运行环境仍须隔离。desk 只维护通用目录、任务和全局入口，不能静态依赖 AI/MCP 实现。

- 持久后台通过 `context.capabilities` 注册版本化的输入/输出 Schema、影响、确认和执行规则；消费方先发现，再使用本次返回的 handle 调用。接口见 [插件 API](plugin-api.md)。不得直接导入其他插件内部代码。
- 新包使用 `requiredHostFeatures:["desk.capabilities.v1"]`；提供全局对话入口时另声明 `desk.entries.v1`，在目标视图声明 `contributes:{entries:["global-conversation"]}`。宿主只挂载入口，AI 会话、模型与工具适配均属于插件。
- 能力注销、停用、崩溃后立即撤销发现；重启不能复用旧 instanceId/descriptorRevision。目录变化后重发现。取消是请求，不能把超时或中断说成外部操作已撤销；不得自动重试有副作用的调用。
- 图标固定放在包内 `ico/icon.svg`，清单 `icon` 指向该文件。默认采用简单手绘黑白线条，禁止在代码中用业务专属 emoji 替代。纯服务/资源插件仍可不展示图标。
- 用户自定义图标保存在数据目录 `plugin-icons/<pluginId>/icon.<ext>`，索引为 `plugin-icons/index.json`，不能覆盖安装包。支持静态 SVG、PNG、JPEG、WebP，单文件最多 512 KiB；SVG 禁用脚本、外部资源等可执行内容。重装不清除覆盖图标，重置恢复包内图标。侧栏、配置、窗口与最小化气泡共用该图标。
- AI 引擎由 AI 插件首次使用时安装至自身数据空间，支持受校验的离线引擎包；固定版本与架构，原子安装。启动使用绝对路径和受控环境，不依赖系统 Agent CLI；Codex、Claude Code 分开安装、分开登录，历史固定记录对应引擎。
- 默认在独立空间登录。用户明确点击“复制本机授权”后，允许读取对应引擎的授权文件或 macOS 钥匙串，并写入独立空间的 0600 副本，不修改来源。skills 与全局规范由独立开关控制，仅同步 skills 和 AGENTS.md/CLAUDE.md；禁止复制完整 HOME、原生 settings、hooks、MCP 密钥和历史。工作目录规范由各引擎原生读取。旧配置、密钥、PTY 会话历史保留，旧入口兼容，不默默迁移认证。
- MCP 插件管理本地 Python/JS 服务、第三方转接和期望运行状态，已启动工具发布到工作台目录。桌面恢复只恢复此前期望运行的服务；用户手动停止后不自动复活。

验收必须分别报告：宿主能力调用、原生引擎工具发现、真实模型选择调用。前两项成功不代表模型端调用已验证。使用临时数据副本检查重启、取消、崩溃和数据兼容，不能操作真实用户数据做破坏性测试。

## 独立配置页面（desk.settings.v1）

每个已安装插件均有宿主配置按钮，弹窗固定展示名称、版本、作者与图标，并提供修改图标入口。
旧包无需更新即可使用；未声明作者时显示“未提供”。用户图标仍写入独立的 plugin-icons 数据目录，升级不覆盖。
插件可声明独立配置页，不将其加入 views，避免作为普通窗口出现在工作空间：

```json
{
  "author": { "name": "开发者或团队" },
  "settings": { "entry": "dist/renderer/settings.html" },
  "requiredHostFeatures": ["desk.settings.v1"]
}
```

author 也可使用字符串。settings 适用于三种插件类型；service/resource 不能声明普通工作空间 views，但可提供配置页。
entry 必须为包内文件，随依赖资源一并打包，纳入完整性校验；构建脚本负责产出该页面。
未启用或正在操作的插件仅展示宿主信息；启用后重新打开配置可加载页面。
配置页使用独立 desk-plugin://<pluginId> 站点和现有沙箱通信桥，调用方式与普通视图相同（见插件 API）。
插件通过自身 RPC 读取、校验、保存自己的配置，宿主不解释插件字段、不代存密钥；资源插件不支持后台 RPC。
页面不能替换宿主元信息或直接访问宿主 DOM。修改图标不会重载页面；关闭弹窗释放页面与事件订阅，未保存内容由插件自行提示或保存。

## 插件开发方式

在仓库 `plugin-dev/` 中开发、构建并输出 `.plg`，通过插件中心右侧的导入按钮安装。工作台不再提供开发面板、开发 Agent 入口或独立预览 IPC；原开发测试数据不自动删除。旧清单的 `desk.development.v1` 声明仅兼容读取，不再代表提供预览能力，新插件不得声明。

## 桌面悬浮插件（0.1.17）

需要常驻悬浮视图时，在 application 持续后台插件的清单视图声明 `presentation.type:'overlay'` 与展开/收起尺寸，并声明 `desk.overlays.v1`。宿主只提供外壳、层级、位置、收起/恢复和沙箱桥接；业务脚本与图表属于插件。收起后 frame 保留，停止采样等业务行为仍由插件生命周期负责。详细消息和尺寸范围见插件 API。

资源监控插件源码位于 `plugin-dev/resource-monitor/`，首版 0.1.0；需要新宿主 0.1.17。它通过 `desk.runtime-directory.v1` 取得当前运行实例，再在独立后台使用 macOS 系统进程计数采样。统计范围是后台及可归属子进程，包含监控后台本身，排除采集命令和 Electron 共享界面/网络进程；不是整机资源使用率。网络包含回环流量，计数重置后重建基线，不承诺捕获所有短命进程。默认 2 秒、最近 120 点，配置支持 2/5/10 秒。没有第三方运行依赖，不隐式提权；未验证的平台不宣称支持。

采集子进程以独立进程组创建，并仅把本实例正在使用的采集器 PID 登记给宿主，以便异常回收；被观测插件的 PID 绝不能作为监控实例的 ownProcesses。设置在 `plugin-data/resource-monitor/settings.json`，卸载默认保留，悬浮位置与状态由通用宿主外壳按稳定 ID 保存。

### 单实例悬浮应用（0.1.19）

在 application 清单声明 `singleInstance:true` 并为视图声明 overlay presentation。宿主只保留悬浮面板，不显示“在窗口中打开”、新建窗口按钮和顶部标签。重复点击插件图标会展开同一页面；收起为标题横条，展开恢复声明尺寸，frame 与后台不重新创建。

资源监控属于 application（有界面和采样后台），不是 resource 静态资源类型。其默认展开尺寸 380×380，收起尺寸 340×36。单实例属性与后台运行方式独立；旧清单未声明时仍允许多窗口。
