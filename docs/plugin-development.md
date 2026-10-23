# Work Desk 插件开发指南

适用宿主：Work Desk 0.1.2+，插件 API 2、dataVersion 1。读者包括插件开发者和接手实现的 AI。
接口详细表见 [插件 API](plugin-api.md)，服务管理与旧 Adapter 升级见 [MCP 使用说明](mcp-plugins.md)。

## 目标和边界

这是一个桌面宿主加载独立能力的场景。主要矛盾是插件需要共享桌面和互相协作，但不能把业务耦合进宿主，也不能因单个插件故障拖垮其他插件。
因此桌面只负责窗口、通用 RPC、服务发现和生命周期；业务全部在插件内。独立后台进程负责故障隔离，独立站点 frame 负责页面隔离，版本化服务契约负责协作。
验证标准：空桌面可用；一个插件崩溃后桌面与其他插件可用；停用只回收目标实例的任务；保留数据重装可以继续读取原配置和历史。

当前只接纳可信本地插件。安全权限协议、签名和市场审核暂不实现，详见末尾边界说明。

## 三种类型与四个属性

| type | 用途 | 页面与图标 | 后台 |
|---|---|---|---|
| application | 用户操作的应用，例如 AI、MCP 管理 | 可有页面；图标可隐藏 | none / task / service |
| service | 给其他功能提供能力 | 无页面、无桌面图标 | none / task / service |
| resource | 静态文件，例如供消费方使用的图片、样式 | 无页面、无桌面图标 | 只能 none |

类型描述用途，其他属性单独声明：

| 属性 | 值与实际效果 |
|---|---|
| showIcon | 布尔值；控制桌面侧栏图标，隐藏不等于禁用，应用仍可从插件中心打开 |
| loadOnStartup | 布尔值；启用的 service 后台为 true 时随宿主启动/启用/安装激活，为 false 时第一次 RPC 激活 |
| background | none 不创建后台；task 首次 RPC 启动、全部并发 RPC 完成后退出；service 激活后持续到停用/退出/故障 |
| type | application / service / resource，决定是否允许界面 |

约束：service/resource 的 showIcon 必须 false 且不能声明页面；resource 的 background 必须 none；none 不能有 main；task 必须 loadOnStartup:false，不能发布持久服务。
none 的 loadOnStartup 不执行代码、不创建进程，资源按访问读取。task 没有定时器或启动任务调度接口，只能由调用触发。
旧 API 2 清单缺失属性时默认 application、true、true、service，保持原有行为。新包应显式写全，旧宿主不支持这些新语义。

已有插件：AI Agent 0.2.2 与 MCP 0.2.0 均为 application / true / true / service。MCP 已内置 AI 接入，不再需要独立 Adapter 图标或包。

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
  "main": "src/main/common/index.mjs",
  "views": [{"id":"main","title":"Example","entry":"src/resource/index.html"}]
}
```

ID 为 `[a-z][a-z0-9-]{0,63}`，发布后保持稳定；数据归属靠 ID，改名不应改 ID。所有入口都必须存在且位于包内。
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
日志包含插件 ID/任务 ID，不输出令牌、环境变量或凭据。

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
    parent.postMessage({ type: 'desk:invoke', id, method: 'plugin.invoke', args: [method, ...args] }, 'desk-host://desktop');
  });
}
const result = await invoke('example.echo', 'hello');
```

完整实例参照 `plugins/plugins/ai-agent/src/renderer/api.js`。后端 RPC 参数/返回值必须可通过 IPC 序列化；每次 RPC 有期限，默认 30 秒。
宿主绑定页面所属插件，页面不传 pluginId。除 plugin.invoke 外可请求 host.chooseDirectory 和 storage.getPreferences。
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
npm run pack:plugin -- plugins/plugins/mcp
# 默认输出 plugins/dist/<ID>-<version>.plg
# 自定义输出必须位于源插件目录之外
npm run pack:plugin -- plugins/plugins/mcp /tmp/mcp.plg
tar -tzf /tmp/mcp.plg
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
