# 本地插件 API v2

插件通过插件中心选择 `.plg` 文件导入。`.plg` 是标准 gzip 压缩 tar 归档（tar.gz），归档根目录包含 `plugin.json` 和相对入口；开发接口继续支持目录导入。需要后台时由宿主拥有的 worker 入口启动，每个已运行后台一个独立进程；插件入口不在 Electron 主进程执行。界面由插件提供，在 `desk-plugin://<plugin-id>/` 独立站点的沙箱 frame 中运行。

当前不提供恶意代码沙箱或在线市场。包内符号链接、硬链接、越界路径/入口、特殊文件及不兼容 API/dataVersion 会被拒绝；归档最多 10000 个条目、展开总大小 512 MiB。API v1 不自动迁移入口代码；保留数据后卸载，导入 API v2 包即可继续使用相同 ID 的数据。

完整接入步骤、类型与生命周期限制见 [插件开发指南](plugin-development.md)。新属性需要 Work Desk 0.1.2 或更新版本；保持 apiVersion 2 兼容旧包，旧清单默认 application / 显示图标 / 启动加载 / 持续后台。

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
| plugin.invoke | [注册方法名, ...业务参数] |
| host.chooseDirectory | [] |
| storage.getPreferences | [] |

回复为 `{type:'desk:result',id,value}` 或 `{type:'desk:result',id,error:{code,message}}`。事件为 `{type:'desk:event',pluginId,channel,value}`，仅转发归属插件；主题为 `{type:'desk:theme',theme}`。AI 插件 src/renderer/api.js 提供完整实现。

宿主 IPC 只接受桌面主 frame，拒绝陌生 sender、子 frame、未知方法及超出上限的 payload。后台事件始终附带真实归属。界面进程退出会记录 PLUGIN_VIEW_CRASHED、显示插件 ID，并允许通过侧栏重新打开；不关闭该插件后台任务。

## 管理生命周期

plugins.preview(id,'disable'|'remove') 返回插件注册的任务快照和 confirmationToken。disable(id,token)、remove(id,'keep'|'clear',token) 验证相同快照；任务增加、退出、改名或折叠等变化会要求重新确认。不同操作意图返回 PLUGIN_BUSY，显式退出期间阻断新操作。

卸载默认保留 plugin-data/当前ID；清理失败保留 state:'uninstalled',cleanupPending:true，通过 plugins.retryCleanup(id) 重试。卸载的内置插件不会自动重装。旧 API 包报错时保留数据，需手动保留卸载后导入新包。

## AI Agent 插件内部契约

适配器、会话、Git、回放、CLI 配置和布局均属于 plugins/plugins/ai-agent，不是 desk 的插件 API。内置插件注册自己的方法，自己的视图调用自己的方法。

适配器 buildLaunch(input) 返回 {command,args,env}，使用可执行文件和参数数组，不拼接 shell 命令。能力声明包括 restore、fork、activity、permissions；支持 Codex 输入协议时才声明 inputProtocol:'codex'。parseActivity 只依据明确 CLI 信号，跨数据块处理，不以静默判断完成。

resolveContext 的结果是权威值：unknown 清除继承的旧 ID。Codex 按每个 PTY 的独立日志选择最近可可靠识别的持久根，忽略临时和嵌套线程；有歧义时恢复使用选择器，分叉返回 CONTEXT_UNKNOWN。原生三档权限及旧归档参数均由插件维护，宿主不解释权限模式。

## 打包插件

先运行 `npm run build` 生成插件界面，再运行：

```sh
npm run pack:plugin -- plugins/plugins/ai-agent
# 或指定输出位置（必须在源插件目录之外）
npm run pack:plugin -- plugins/plugins/ai-agent plugins/dist/ai-agent.plg
```

默认输出 `plugins/dist/<插件ID>-<版本>.plg`。可用系统 `tar -tzf <文件.plg>` 查看内容；无需改名。升级继续按保留数据卸载、导入相同 ID 的新版包处理，数据版本必须兼容。

## 插件服务发现与调用

后台通过 `context.services.register({contract:'domain.name.v1',method:'registered.method'})` 发布已注册方法。
`discover(contract)` 仅返回当前启用且存活实例的 `{pluginId,contract,method}`；`invoke(provider,input,{timeout})` 调用一个对象参数。
宿主绑定真实调用者，拒绝旧实例、私有方法、循环和超过八跳的调用。整个调用链共用截止时间，包括资源解析；服务发现不构成激活依赖。

MCP 插件发布 `mcp.connections.v1`，返回 `{version:1,services:[{id,name,state,url,headers}]}`。
仅运行中的服务包含本机入口和临时 Bearer；上游命令、环境变量、请求头不会随发现接口发布。
MCP 插件内置 AI 接入，发布 `agent.launch-config.v1`，接收 `{clientId,cwd,mode}`，返回 `{version:1,overrides:[]}`。
AI 在每次新建、恢复、分叉时发现可选提供者，只接受 `mcp_servers.desk_*.url/http_headers` 的会话启动覆盖；多个提供者报错。
选择的服务失效时阻止新会话启动；已经运行的会话没有热添加能力。其他 CLI 暂不注入，Codex 用户配置文件不改写。
