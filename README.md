# DeckPg

基于插件的本地 AI 工作台。`desk` 提供桌面、基础黑白主题、插件管理、隔离运行和通用能力协议；AI、MCP、文本、工作流、抓包和资源监控由插件提供。

## 当前版本

工作台版本 **0.1.23**，已验证 macOS Apple Silicon（arm64）。Linux 实现按平台目录隔离，尚未完成实机验收。

| 插件 | 稳定 ID | 版本 | 多开 |
| --- | --- | --- | --- |
| AI Agent | `ai-agent-sessions` | 0.6.7 | 支持 |
| MCP 服务 | `mcp-services` | 0.4.7 | 单实例 |
| 文本编辑器 | `text-editor` | 0.1.6 | 支持 |
| 工作流编排 | `work-flow` | 0.5.2 | 支持 |
| Agent 抓包 | `codex-capture` | 0.2.1 | 单实例 |
| 资源监控 | `resource-monitor` | 0.1.2 | 单实例悬浮面板 |

## 领域目录

```text
desk/
  src/main/common/          宿主、插件运行时、存储及 IPC
  src/main/os/              mac、linux 及共用 POSIX 实现
  src/renderer/             桌面、标签、设置及插件视图桥接
  src/resource/             桌面资源
  build/                    构建、安装及打包脚本
  test/                     宿主与隔离测试
  dist/releases.noindex/    macOS 应用和安装包
plugin-dev/
  ai-agent/                多引擎 AI 插件
  mcp/                     MCP 部署、转接及能力发布
  text-editor/             文本编辑与离线文档绘图
  work-flow/               工作流与消息处理
  codex-capture/            Agent 请求抓包
  resource-monitor/        资源监控
  dist/                    .plg 和离线引擎包（不提交 Git）
plugins/market/             插件市场边界，暂未实现在线市场
```

插件开发目录与运行时安装目录分离。macOS 正式数据目录保持为 `~/Library/Application Support/Work Desk/`，包含：

- `plugins/<pluginId>/`：已安装插件，支持手工解压后校验发现；兼容旧 `packages/<pluginId>/`。
- `plugin-data/<pluginId>/`：各插件配置、密钥、引擎、日志和历史。
- `plugin-icons/<pluginId>/`：用户自定义图标，不覆盖插件包内默认图标。

## 安装和升级

macOS arm64 产物位于 `desk/dist/releases.noindex/DeckPg-0.1.23-arm64.dmg` 及同名 `.zip`。应用使用自定义图标和本地临时签名，尚未进行 Developer ID 签名及 Apple 公证。

正式安装统一为 `/Applications/DeckPg.app`。从源码更新时先正常退出工作台，再执行：

```sh
npm run dist:mac
npm run install:mac
open /Applications/DeckPg.app
npm run check:mac-installation
```

安装脚本只替换应用包，校验签名及系统启动入口；失败时回滚旧应用。配置、插件、密钥及历史保留在外部数据目录，不随应用包替换。正式运行仅允许一个实例。

插件通过用户菜单的插件入口导入 `.plg`，同 ID 升级保留数据。插件包为标准 gzip tar，包含清单、代码、构建资源及 SHA-256 完整性清单；不包含用户配置或密钥。禁用与关闭分离：关闭释放页面和后台但保留启用状态，禁用阻止继续使用。卸载默认保留数据。

## 桌面和插件协作

点击左侧插件图标复用最近使用的页面。普通插件以顶部标签切换，内容直接铺满下方工作空间；没有外框、外层拖动缩放、最大化或最小化按钮。选中标签与内容背景一致，标签之间保留短竖线，标签与内容之间没有横线。允许多开的插件双击标签新建；是否多开由清单 `singleInstance` 决定。资源监控保留独立悬浮面板形态。

侧栏支持隐藏、调宽、图标按细网格移动和单独缩放。用户可隐藏名称、改名和更换图标。基础主题支持跟随系统，桌面及插件提供中英文界面机制。

插件后台运行在独立进程，界面运行在独立站点的沙箱 frame。通过 `desk.capabilities.v1` 注册、发现和调用能力，不直接导入其他插件的实现。全局 AI 对话入口由 `desk.entries.v1` 挂载 AI 插件视图。切换标签不重新加载页面或停止后台任务。

AI 插件独立安装和管理 Codex、Claude Code，支持在线安装、离线引擎包和独立登录；用户明确选择时才复制本机授权或同步 skills、规范。不会隐式复用系统 CLI 或修改本机授权。MCP 插件部署 Python/JavaScript 服务、转接 stdio/Streamable HTTP 服务，并向 AI 发布已启用服务的能力。

独立进程是故障边界，不是恶意代码的权限沙箱。当前仅导入可信本地插件；完整性校验不等同于发布者签名。故障清理仅针对本次运行登记的进程，不使用历史 PID。

## 开发和验证

需要 Node.js 22+、npm 和 macOS 原生构建工具。复用锁定依赖：

```sh
npm ci
npm start
npm test
# 宿主界面夹具，不启动业务插件、不使用正式数据
npm run test:desktop-ui
# 涉及跨插件契约或生命周期时，运行对应 Electron 集成用例
npm run test:electron
# 构建并单独分发插件
npm run build
npm run pack:plugin -- plugin-dev/ai-agent
```

`postinstall` 为 Electron 重建 node-pty。打包应用测试需先构建安装包。测试按影响领域选择，不将工具网关测试、原生工具发现和真实模型调用混称为通过。需要联网、账户授权或外部服务的人工验收，另按对应插件说明执行。

0.1.23 桌面改动已通过 41 项宿主界面回归；正式安装后核对 1,019 个配置、插件数据和图标文件，均未改动或丢失，并确认正常启动及唯一应用入口。本次桌面样式回归不代表重新完成全部插件业务验收。

## 开发规范

- [项目约束](AGENTS.md)
- [插件开发指南](docs/plugin-development.md)
- [插件 API v2 与能力协议](docs/plugin-api.md)
- [AI Agent 多引擎](docs/ai-agent-multi-engine.md)
- [MCP 使用及升级](docs/mcp-plugins.md)
- [MCP 服务开发](docs/mcp-service-development.md)

密钥、授权、运行时数据、安装包和本机验收记录不提交 Git；示例和测试仅使用虚构配置。

## 许可证

项目自有源码采用 [MIT License](LICENSE)，第三方依赖遵循各自许可证。
