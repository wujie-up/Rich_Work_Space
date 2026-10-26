# AI Agent 多引擎使用说明

AI Agent 会话插件统一管理多个引擎，当前提供 Codex 和 Claude Code。主要解决桌面对系统 CLI 安装及登录状态的隐式依赖：程序、账户目录及配置均由插件独立管理，用户明确选择时才复制本机授权、技能或全局规范。

## 安装与选择

1. 在插件中心导入 `plugin-dev/dist/ai-agent-sessions-0.6.7.plg`，升级原有同 ID 插件，保留数据。
2. 打开插件配置，选择 Codex 或 Claude Code，在线安装或导入对应的离线 `.engine.tar.gz` 包。当前受管引擎仅验证 macOS Apple Silicon。
3. 分别独立登录，或点击“复制本机授权”。登录可能要求在浏览器中完成账户授权。Claude 云端服务需要有效的 Claude Code 账户权限。
4. 按需勾选复用本机 skills、规范，并设置默认引擎。新对话也可单独选择引擎；历史对话保留创建时的引擎和版本，不随默认选择切换。

固定版本为 Codex 0.164.0、Claude Code 2.1.310。下载和离线导入均校验固定摘要、版本及新账户空间的未登录状态，校验失败不发布安装结果。插件包不包含这两个较大的引擎程序。

## 数据与授权边界

以工作台数据目录下 `plugin-data/ai-agent-sessions` 为根：

| 内容 | 位置 |
| --- | --- |
| 多引擎选择、复用选项 | `engines.json` |
| Codex 程序、账户 | 原有 `runtimes/`、`profiles/`，保持兼容 |
| Claude Code 程序、账户 | `engines/claude/runtimes/`、`engines/claude/profiles/` |
| 原终端配置和历史 | 延续原文件和记录，不进行跨引擎转换 |

独立启动设置隔离的 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、XDG 和临时目录，不继承系统 CLI 路径及 shell 中的提供商密钥。macOS 系统代理作为网络路由沿用，本机回环工具网关绕过代理。

“复制本机授权”读取对应 `.codex/auth.json` 或 `.claude/.credentials.json`；文件不存在时尝试 macOS 钥匙串。只在显式操作时复制到默认隔离账户目录，文件权限为 0600，不改写源文件，不记录授权内容。复制后两边独立更新；原授权过期时需要重新复制或独立登录。

技能及规范复用也是显式开启、启动前同步的副本：Codex 使用 `.codex/skills`、`.agents/skills`、`.codex/AGENTS.md`；Claude 使用 `.claude/skills`、`.claude/CLAUDE.md`。项目规范由对应引擎在工作目录原生读取。不复制本机完整 settings、hooks、MCP 密钥或历史。

“移除引擎”仅删除程序，保留授权、配置和历史。替换授权或移除程序前需要停止该引擎的活动任务。插件 ID 和 dataVersion 保持不变。

## 协作协议

Codex 使用原生 app-server 协议；Claude Code 使用原生双向 stream-json 协议，由插件适配到现有对话、审批、提问和中断事件。Claude 的工具审批不会自动放行。Claude 会话恢复使用原生 session ID，终端模式暂不支持分叉。

结构化 AI 对话通过仅监听本机回环地址、逐会话随机令牌保护的 MCP 网关发现工作台能力，调用继续经过工作台能力协议。Claude 终端模式尚不提供同等工具网关能力；需要工作台插件工具时使用 AI 对话。

## 验证与限制

历史验收记录及离线包摘要保存在本机 `plugin-dev/dist/verification/`，不随源码提交；不同版本的验收范围须分别核对。Codex 已完成真实云端对话和工作台工具调用；Claude Code 已完成真实程序安装、隔离账户与原生工具发现，尚未完成需要 Claude 登录授权的云端模型调用。两个引擎的浏览器登录完成步骤仍需用户实际授权。
