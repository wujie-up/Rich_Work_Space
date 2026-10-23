# Work Desk

本地插件桌面。`desk` 只提供空白桌面、基础黑白主题、插件管理及通用运行机制；AI Agent、终端、Codex 恢复与分叉、Git 等能力由 AI Agent 插件提供。插件后台运行在独立进程，界面运行在独立站点的沙箱 frame。

## 领域目录

```text
desk/
  src/main/common/          桌面、插件运行时、存储及 IPC
  src/main/os/              mac、linux 及共用 POSIX 实现
  src/renderer/             空白桌面、插件中心、基础主题、插件视图桥接
  src/resource/             桌面文件资源
  build/                    构建脚本与打包配置
  test/                     宿主与隔离测试
  dist/                     桌面编译结果及 releases 安装包
plugins/
  market/                   插件市场边界，暂未实现
  plugins/
    ai-agent/               AI Agent 领域，稳定 ID 为 ai-agent-sessions
      title.md
      ico/
      src/main/common/      会话、适配器、Git、恢复与分叉
      src/main/os/          平台进程控制
      src/renderer/         工作区、历史、终端及 CLI 配置
      src/resource/
      test/
      dist/
    work-flow/              工作流领域占位
    theme/                  扩展主题领域占位
```

依赖方向、故障隔离和 OS 边界的长期约束见 [AGENTS.md](AGENTS.md)。市场、工作流和扩展主题仅记录边界，没有增加未提出的业务实现。

## 安装与使用

本次构建为 macOS Apple Silicon（arm64）：

- `desk/dist/releases/Work Desk-0.1.0-arm64.dmg`：打开后将应用拖入 Applications。
- `desk/dist/releases/Work Desk-0.1.0-arm64.zip`：同版本应用压缩包。
- `desk/dist/releases/mac-arm64/Work Desk.app`：构建后的应用。

此构建没有 Developer ID 签名和 Apple 公证，使用默认 Electron 图标。仅验证 macOS arm64；Linux 代码已归入对应平台目录，尚未实机验证。

启动后先显示空白桌面，通过侧栏进入“AI Agent 会话”或“插件中心”。AI 插件支持最多 12 个终端、拖拽排序、拉伸、折叠、归档回放和 Git 分支切换。Codex 需要本机已安装并完成登录；应用使用已有 CLI 环境，不代管凭据。Finder 环境找不到命令时，在插件的“CLI 配置”中填写绝对路径，参数使用 JSON 数组：

```json
{
  "codex": { "command": "/opt/homebrew/bin/codex", "args": [] },
  "custom": { "command": "/absolute/path/to/agent", "args": ["argument with spaces"] }
}
```

Codex 权限使用原生三档：“请求批准”“帮我批准”“完全访问权限”，默认请求批准。帮我批准需要 CLI 支持 `--approve-for-me`；完全访问使用原生关闭沙箱及审批的参数。旧归档恢复与分叉保留原权限，不自动提升权限。自定义 CLI 默认只支持终端和回放。上下文无法可靠识别时，恢复打开原生选择器，分叉明确报错；状态只依据 CLI 明确信号，不根据输出安静推断完成。

### 已有安装升级

本次插件 API 升为 **v2**，插件 ID 和 dataVersion=1 保持不变。数据目录内的旧 API v1 插件会显示不兼容错误，不在宿主执行，也不会被应用更新静默覆盖。请在插件中心卸载旧“AI Agent 会话”，选择**保留数据**，运行 `npm run build` 和 `npm run pack:plugin -- plugins/plugins/ai-agent`，再导入生成的 `plugins/dist/ai-agent-sessions-0.2.0.plg` 包。该包包含构建后的插件界面；配置、布局和历史继续按原插件 ID 读取。卸载后未重新导入的内置插件不会自动恢复。

关闭会话会终止该 PTY 进程组并归档最后 2 MiB 输出。macOS 关闭窗口保留应用和会话；菜单或 ⌘Q 显式退出时，确认关闭并归档后退出。折叠不停止 CLI。禁用、卸载前列出目标插件的任务，取消后继续运行，任务快照变化需要重新确认。

卸载默认保留数据；清理只作用于该插件在 Work Desk 内的配置、布局、日志和历史，不删除工作目录、Agent 全局历史或凭据。故障只回收当前运行实例登记的进程，重启后不会依据旧 PID 接管或结束进程。后台崩溃后可重新启用；界面崩溃后可通过侧栏重新打开。当前插件是可信本地代码，独立进程用于故障隔离，不构成恶意代码的权限沙箱。

正式数据默认位于 `~/Library/Application Support/Work Desk/`。可通过 `--desk-data=/absolute/path` 指定独立目录；测试均使用自己的临时数据目录。

## 开发与验证

需要 Node.js 22+、npm 和 macOS 原生构建工具；复用项目锁定的依赖。

```sh
npm ci
npm start
npm test
# 桌面界面独立验证：只构建desk，模拟宿主契约，不启动业务插件
npm run test:desktop-ui
npm run dist:mac
npm run test:electron
```

`postinstall` 为 Electron 重建 node-pty。更新 Electron 后重新执行 `npx electron-builder install-app-deps` 并验证真实 PTY。Electron 安装包用例需要先打包。构建分别生成桌面及各插件界面，桌面 bundle 不包含 AI/xterm 业务代码。

显式的真实 Codex 验收会使用本机已有 CLI 登录状态，创建自己的测试对话，不恢复用户已有任务：

```sh
node plugins/plugins/ai-agent/test/electron/codex.manual.mjs
node plugins/plugins/ai-agent/test/electron/codex-permissions.manual.mjs
```

增加 `WORK_DESK_PACKAGED=1` 使用打包应用和收窄的 PATH。权限脚本只在自己的临时会话输入 `/status`，核对三档生效模式；恢复/分叉脚本会发送两条固定测试提示。测试对话会留在 Codex 自己的历史中，工作台清理不会删除它们。

[插件 API v2](docs/plugin-api.md)

插件开发与 AI 接入请先阅读 [插件开发指南](docs/plugin-development.md)、[API 协议](docs/plugin-api.md) 和 [MCP 使用与升级](docs/mcp-plugins.md)。

## 许可证

Work Desk 自有源码采用 [MIT License](LICENSE)。第三方依赖仍遵循各自的许可证。
