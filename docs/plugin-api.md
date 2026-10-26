# 本地插件 API v2

插件通过插件中心选择 `.plg` 文件导入。`.plg` 是标准 gzip 压缩 tar 归档（tar.gz），归档根目录包含 `plugin.json` 和相对入口；开发接口继续支持目录导入。需要后台时由宿主拥有的 worker 入口启动，每个已运行后台一个独立进程；插件入口不在 Electron 主进程执行。界面由插件提供，在 `desk-plugin://<plugin-id>/` 独立站点的沙箱 frame 中运行。

当前不提供恶意代码沙箱或在线市场。包内符号链接、硬链接、越界路径/入口、特殊文件及不兼容 API/dataVersion 会被拒绝；归档最多 10000 个条目、展开总大小 512 MiB。API v1 不自动迁移入口代码；保留数据后卸载，导入 API v2 包即可继续使用相同 ID 的数据。

Rich_Work_Space 0.1.6 起支持扫描数据目录下 `plugins/<pluginId>/` 中已解压的插件，并检查新版包的 SHA-256 完整性清单；旧 `packages` 安装位置仍兼容。开发源码在 `plugin-dev/`，不得与安装目录混用。

完整接入步骤、类型与生命周期限制见 [插件开发指南](plugin-development.md)。新属性需要 Rich_Work_Space 0.1.2 或更新版本；保持 apiVersion 2 兼容旧包，旧清单默认 application / 显示图标 / 启动加载 / 持续后台。

## 清单与入口

```json
{
  "id": "example-agent",
  "name": "Example Agent",
  "version": "1.0.0",
  "apiVersion": 2,
  "dataVersion": 1,
  "type": "application",
  "showIcon": true,
  "loadOnStartup": true,
  "background": "service",
  "main": "src/main/common/index.js"
}
```

ID 匹配 `[a-z][a-z0-9-]{0,63}`。重装同 ID 前必须已卸载、没有待清理数据，且 dataVersion 相同。ESM 包需要 package.json 声明 `"type":"module"`，或使用 `.mjs` 入口。包必须包含运行所需文件；开发清单中的 renderer 是本项目构建脚本的界面入口，安装后实际页面使用 views.register 的 entry。

```js
export function activate(context) {
  context.methods.register('example.echo', (value) => value);
  context.lifecycle.register({ snapshot: () => [], stop: async () => {} });
  context.views.register({ id: 'main', title: 'Example', entry: 'dist/renderer/index.html' });
}

export function deactivate() {}
```

有后台的插件必须导出 activate、deactivate；background:none 不声明 main，通过清单 views 声明页面。激活失败会尝试 deactivate，再关闭该 worker；正常停用先阻断新操作、关闭并归档插件任务，再 deactivate 和回收进程。错误会回传并保留阶段，不显示虚假成功。故障清理失败时，重新启用、卸载及退出均须重试清理。

## 后台 PluginContext

| 接口 | 契约 |
|---|---|
| pluginId | 当前包的稳定 ID |
| methods.register(name, handler, options) | 注册 RPC 方法，参数与返回值必须可通过 Node IPC 序列化 |
| views.register({id,title,entry}) | 注册独立页面；entry 是包内相对路径 |
| lifecycle.register({snapshot,stop}) | snapshot 返回任务数组；stop(reason) 关闭并归档本插件任务 |
| emit(channel,value) | 发送插件事件；宿主附加真实 pluginId |
| ownProcesses(pids) | 报告本次运行实例拥有的进程组父 PID；不读取历史 PID 清理 |
| resources.report(entries) | 报告外部共享资源占用，见下文 |
| storage | 通用 Storage 实例，读写 userData 内相对路径；数据约定放 plugin-data/当前ID/ |
| importModule(name) | 解析宿主已有运行依赖；AI 插件用于加载 Electron ABI 的 node-pty |

后台是可信本地 Node 代码，storage 不是权限隔离边界；插件必须遵守数据归属约定。渲染层无 Node、无任意文件读写和任意 IPC。

方法名例如 sessions.create，必须符合注册器校验且不能重复。options.exclusive=true 使用当前插件的操作锁，避免创建与生命周期变化并发。每个 RPC 有 30 秒超时；后台退出、未捕获异常、超时或无效协议消息会使该插件失败，拒绝未完成请求、回收登记进程并记录插件 ID。宿主及其他插件继续运行，重新启用可创建新 worker。

### 外部共享资源

不同插件可能操作同一个外部资源。资源键对宿主不透明，例如 AI 插件使用 `git:<canonical-root>`，desk 无须理解 Git：

- methods.register 的 resource(...args) 返回资源键或 null；宿主先解析键，再在同步锁保护下调用实际方法。
- 普通资源调用持有共享锁；resourceExclusive=true 要求无其他调用、无 busy 报告、无尚未到期的 busyUntil。锁按资源键隔离。
- resources.report([{key,busy,busyUntil}]) 更新当前插件的占用快照；busyUntil 是毫秒时间戳。故障清理完成前保留恢复状态，避免提前允许独占操作。

此机制用于跨插件保护同一仓库的切换操作；具体业务检查和资源状态由插件维护，不在 desk 增加 Git 规则。

## 界面桥接与宿主接口

桌面 window.workDesk 仅暴露 plugins、storage.getPreferences/savePreferences、受限 host 及事件订阅。插件业务方法通过 plugins.invoke(pluginId,method,argsArray) 调用，不在 preload 维护 sessions、Git 或适配器 API。

插件 frame 使用 postMessage 与父桌面通信。请求为 `{type:'desk:invoke',id,method,args}`，发送到 `desk-host://desktop`。父桌面只接受该 frame 的精确 window 和 origin；pluginId 由宿主绑定，不由插件自报。允许：

| method | args |
|---|---|
| plugin.invoke | [注册方法名, 业务参数数组] |
| host.chooseDirectory | [] |
| storage.getPreferences | [] |

回复为 `{type:'desk:result',id,value}` 或 `{type:'desk:result',id,error:{code,message}}`。事件为 `{type:'desk:event',pluginId,channel,value}`，仅转发归属插件；主题为 `{type:'desk:theme',theme}`。AI 插件 src/renderer/api.js 提供完整实现。

宿主 IPC 只接受桌面主 frame，拒绝陌生 sender、子 frame、未知方法及超出上限的 payload。后台事件始终附带真实归属。界面进程退出会记录 PLUGIN_VIEW_CRASHED、显示插件 ID，并允许通过侧栏重新打开；不关闭该插件后台任务。

## 管理生命周期

plugins.preview(id,'close'|'disable'|'remove') 返回插件注册的任务快照、清单提供的 closeDescription（缺失时为空字符串）和 confirmationToken。closeDescription 只作为纯文本说明，不改变任务确认语义。close(id,token)、disable(id,token)、remove(id,'keep'|'clear',token) 验证相同快照；任务增加、退出、改名或折叠等变化会要求重新确认。不同操作意图返回 PLUGIN_BUSY，显式退出期间阻断新操作。

卸载默认保留 plugin-data/当前ID；清理失败保留 state:'uninstalled',cleanupPending:true，通过 plugins.retryCleanup(id) 重试。卸载的内置插件不会自动重装。旧 API 包报错时保留数据，需手动保留卸载后导入新包。

关闭与禁用独立：`plugins.close(id,token)` 调用生命周期 stop（reason 为 `close`）和 deactivate，关闭运行进程并保留原启用状态；`plugins.forceClose(id)` 跳过插件回调终止运行进程，也保留原启用状态。成功后宿主发出 `plugins.closed`（`{pluginId}`），桌面通过 `events.pluginClosed` 关闭该插件的全部窗口。关闭不清理配置或历史，启用的插件可再次按需启动；只有 disable/forceDisable 改为禁用。

## AI Agent 插件内部契约

适配器、会话、Git、回放、CLI 配置和布局均属于 plugin-dev/ai-agent，不是 desk 的插件 API。内置插件注册自己的方法，自己的视图调用自己的方法。

适配器 buildLaunch(input) 返回 {command,args,env}，使用可执行文件和参数数组，不拼接 shell 命令。能力声明包括 restore、fork、activity、permissions；支持 Codex 输入协议时才声明 inputProtocol:'codex'。parseActivity 只依据明确 CLI 信号，跨数据块处理，不以静默判断完成。

resolveContext 的结果是权威值：unknown 清除继承的旧 ID。Codex 按每个 PTY 的独立日志选择最近可可靠识别的持久根，忽略临时和嵌套线程；有歧义时恢复使用选择器，分叉返回 CONTEXT_UNKNOWN。原生三档权限及旧归档参数均由插件维护，宿主不解释权限模式。

## 打包插件

先运行 `npm run build` 生成插件界面，再运行：

```sh
npm run pack:plugin -- plugin-dev/ai-agent
# 或在统一分发目录中指定文件名
npm run pack:plugin -- plugin-dev/ai-agent plugin-dev/dist/ai-agent.plg
```

默认输出 `plugin-dev/dist/<插件ID>-<版本>.plg`。可用系统 `tar -tzf <文件.plg>` 查看内容；无需改名。升级继续按保留数据卸载、导入相同 ID 的新版包处理，数据版本必须兼容。

## 插件服务发现与调用

后台通过 `context.services.register({contract:'domain.name.v1',method:'registered.method'})` 发布已注册方法。
`discover(contract)` 仅返回当前启用且存活实例的 `{pluginId,contract,method}`；`invoke(provider,input,{timeout})` 调用一个对象参数。
宿主绑定真实调用者，拒绝旧实例、私有方法、循环和超过八跳的调用。整个调用链共用截止时间，包括资源解析；服务发现不构成激活依赖。

MCP 插件发布 `mcp.connections.v1`，返回 `{version:1,services:[{id,name,state,url,headers}]}`。
仅运行中的服务包含本机入口和临时 Bearer；上游命令、环境变量、请求头不会随发现接口发布。
MCP 插件内置 AI 接入，发布 `agent.launch-config.v1`，接收 `{clientId,cwd,mode}`，Codex 返回 `{version:1,overrides:[]}`，Claude Code 返回 `{version:1,mcpConfig:{mcpServers:{desk_<id>:{type:"http",url,headers}}}}`。
AI 在每次新建、恢复、分叉时发现可选提供者，Codex 只接受 `mcp_servers.desk_*.url/http_headers` 的会话启动覆盖，Claude Code 只接受 `desk_*` 的 HTTP 地址与 Authorization 配置；多个提供者报错。
选择的服务失效时阻止新会话启动；旧 PTY 会话没有热添加能力；新独立引擎对话在下一轮检测目录版本变化，通过新网关和 thread/resume 更新工具。其他 CLI 暂不注入；客户端差异由 MCP 领域序列化，AI 引擎适配器仅传入启动参数，用户配置文件不改写。

## 工作台能力协议 desk.capabilities.v1（宿主 0.1.8）

这是新增的结构化调用协议；旧 `context.services` 保持兼容。仅 service 后台发布持久能力。清单声明 `requiredHostFeatures` 后，旧宿主拒绝不支持的新包。

```js
await context.capabilities.register({
  id: 'example.lookup', version: 1, title: '查询', description: '按关键字读取数据',
  inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'], additionalProperties: false },
  outputSchema: { type: 'object' }, effects: ['network.read'], confirmation: 'policy',
  execution: { timeoutMs: 20000, cancellable: true, retry: 'never' }, state: 'ready'
}, async (input, call) => {
  return lookup(input.keyword, { signal: call.signal });
});
const catalog = await context.capabilities.discover({ id: 'example.lookup' });
const task = await context.capabilities.invoke(catalog.providers[0].handle, { keyword: 'error' });
const status = await context.capabilities.getInvocation(task.invocationId);
// 收到事件后读取状态；不要将 invoke 返回值当作业务结果。
const unsubscribe = context.capabilities.subscribe(event => console.info(event.type));
await context.capabilities.cancel(task.invocationId);
unsubscribe();
```

`register(descriptor,handler)` 首次注册；`upsert` 动态替换；`unregister(id,version)` 撤销。处理函数收到 input 与调用上下文（signal、invocationId、traceId、deadline）。
`discover({id?,pluginId?,version?,includeUnavailable?})` 返回 `{catalogRevision,providers}`；每个 provider 有 `{handle,state,descriptor}`。
handle 包含 `pluginId/instanceId/capabilityId/version/descriptorRevision`，必须原样使用。`invoke(handle,input,{timeoutMs?})` 返回 `{invocationId,traceId,state,deadline}`，参数不能延长提供者或父调用期限。
`getInvocation` 返回本调用者可见的任务状态、结果或错误；`subscribe` 接收目录与任务变化。不可用或旧 handle 应重新发现，不能绕过宿主直连插件内部进程。

任务状态：`queued → running → succeeded/failed/cancelled/interrupted`；取消运行中的任务先进入 `cancelling`，直到提供者确认或期限结束。取消后仍可能成功；超时、断连、主机退出不能保证外部副作用撤销。宿主重启将未结束记录标为 interrupted，不自动重放。
输入、输出均限制为可序列化 JSON，最大 1 MiB；输入输出经过 Schema 校验。当前支持的 Schema 子集为 type/properties/required/additionalProperties/items/enum/description/title/minimum/maximum/minLength/maxLength/minItems/maxItems/anyOf/oneOf/default 及布尔 Schema；最大 16 层。不是完整 JSON Schema，不支持 `$ref` 等关键字。

`effects` 中仅 filesystem.read/network.read/workspace.read/document.read 可在 policy 模式免确认；空影响列表、其他影响或 confirmation:always 均由宿主可信界面确认。effects 是可信插件的声明，不能当作恶意代码权限沙箱。execution.timeoutMs 为 1–600000；retry 只允许 never；可选 resource 用于同资源互斥。
宿主绑定真实调用者，最多八跳、拒绝循环；活动任务上限 128。常见错误包括 INPUT_INVALID、OUTPUT_INVALID、RESULT_TOO_LARGE、PROVIDER_UNAVAILABLE、CAPABILITY_CHANGED、CALL_TIMEOUT、RESOURCE_BUSY、SERVICE_CYCLE。旧实例退出后不能继续调用。
任务持久化只写身份、状态、时间与错误代码，不写参数、结果和明文密钥；业务历史由插件负责。运行日志不得打印密钥。

## 通用入口、文件及图标

清单目标视图声明 `contributes:{entries:['global-conversation']}` 由桌面全局按钮挂载，须声明 `desk.entries.v1`；多个提供者由用户选择，选择保存在桌面 origin 的本地配置中。再次打开恢复原窗口，不重复创建会话。
插件页面通过允许桥接 `host.chooseFile` 选择文件、`host.openExternal` 打开 http/https 登录地址；不允许传递 URL 内嵌凭据。文件保存仍属于插件自己的后台方法。

视图入口名称允许 64 字以内的小写字母、数字和连字符，以字母开头。页面可调用 `host.openView(entry, launchContext)` 打开已启用插件贡献的入口，返回 `{windowId}`；无提供者或多个提供者时明确报错。每次创建独立窗口，目标视图通过 `host.getLaunchContext` 获取上下文，自行校验其业务参数。例如 `text-document` 入口接收 `{path,cwd}`，使用文本插件自己的文件读取及大小限制，不覆盖其他窗口的草稿。
桌面通用 `plugins.setIcon/resetIcon` 管理图标，固定文件位置和格式限制见开发规范。插件不得写入其他插件的图标、配置或安装文件。

## 独立配置页面

可选清单字段 `settings: { "entry": "dist/renderer/settings.html" }` 声明配置页；
`author` 为名称字符串或 `{ "name": "团队名称" }`。需要该能力时声明 `requiredHostFeatures: ["desk.settings.v1"]`。
宿主固定提供图标修改、插件名称、版本和作者，其下方加载插件页面。
页面复用 views 的 sandbox、`desk:invoke` / `desk:result` / `desk:event` / `desk:theme` 协议；
`plugin.invoke` 的目标 ID 由宿主依据源 frame 固定，不能通过参数指定其他插件。
页面通过插件自身方法实现配置读写，不新增全局文件或密钥访问权限。关闭配置页面不会禁用插件。

## 插件开发方式

在仓库 `plugin-dev/` 中开发、构建并输出 `.plg`，通过插件中心右侧的导入按钮安装。工作台不再提供开发面板、开发 Agent 入口或独立预览 IPC；原开发测试数据不自动删除。旧清单的 `desk.development.v1` 声明仅兼容读取，不再代表提供预览能力，新插件不得声明。

## 通用悬浮视图与运行实例目录（宿主 0.1.17）

清单 `requiredHostFeatures` 可声明 `desk.overlays.v1` 与 `desk.runtime-directory.v1`。旧宿主会拒绝依赖新协议的包；旧插件不受影响。

视图可附加 `presentation: { type: 'overlay', width: 380, height: 380, collapsedWidth: 340, collapsedHeight: 36 }`。
展开宽度、收起宽度为 240–800，展开高度为 100–800，收起高度为 32–64，单位 CSS px。持续后台运行时，宿主自动挂载独立沙箱悬浮外壳，位于业务窗口上方、设置与确认弹窗下方。尺寸随可见桌面缩小，几何位置和收起状态按插件/视图 ID 保存在宿主 origin；没有运行后台时不挂载，也不会因刷新自动重启已关闭插件。

宿主向视图发送 `{type:'desk:presentation',collapsed:boolean}`。视图可向精确父 origin 发送 `{type:'desk:overlay-summary',text:string}`（最多 240 字）作为横条文本，或 `{type:'desk:overlay-state',defaultCollapsed:boolean}` 设置未保存过的初始状态。仅所属 frame 和精确 origin 的消息有效，文本不解释为 HTML。收起保留 frame 和运行后台。宿主桌面的 `plugins.start(id)` 仅显式启动已启用的持续后台，不向插件 frame 开放。

后台 `await context.host.runtimeDirectory()` 返回 `{version:1,plugins:[{pluginId,name,state,instanceId,pid,ownedPids}]}`。
只返回当前存活后台及其当前登记的进程根，不读取磁盘 PID、不激活按需插件，不返回路径、配置或密钥；调用绑定真实当前运行实例，失效或停止中的实例被拒绝。允许后台定时器调用，不要求嵌套在另一次业务 RPC 内。每次请求仍有期限。`plugins.list()` 的 `running` 是当前内存状态，不持久化。

目录只提供观测身份，不提供终止进程的授权，也不负责资源统计。消费插件负责平台采集和 PID 起始身份核对；PID 消失或变化后不能仅凭旧登记继续归属。目录限制在所在插件管理空间，开发空间不泄漏正式安装实例。

## 单实例界面（宿主 0.1.19）

清单可声明 `singleInstance:boolean`，默认 false。true 时宿主的普通窗口创建入口复用同插件已挂载的页面，并隐藏新建按钮和菜单；不改变后台启停和数据归属。overlay 视图声明 true 时只保留悬浮面板，不提供普通窗口入口，不创建顶部标签。再次打开会展开保留的面板；收起仍保留 frame 和后台。

普通窗口默认名称为“窗口1、窗口2”，按同插件当前开启数独立编号；用户改名后保留改名。多实例插件的 `host.openView` 仍创建独立窗口；单实例插件复用现有窗口。
