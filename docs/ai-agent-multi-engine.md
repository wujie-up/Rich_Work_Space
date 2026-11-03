# AI Agent 多引擎使用说明

AI Agent 会话插件统一管理多个引擎，当前提供 Codex 和 Claude Code。主要解决桌面对系统 CLI 安装及登录状态的隐式依赖：程序、账户目录及配置均由插件独立管理，用户明确选择时才复制本机授权、技能或全局规范。

## 安装与选择

1. 在插件中心导入 `plugin-dev/dist/ai-agent-sessions-0.6.14.plg`，升级原有同 ID 插件，保留数据。
2. 打开插件配置，选择 Codex 或 Claude Code，在线安装或导入对应的离线 `.engine.tar.gz` 包。当前受管引擎仅验证 macOS Apple Silicon。
3. 分别独立登录，或点击“复制本机授权”。登录可能要求在浏览器中完成账户授权。Claude 云端服务需要有效的 Claude Code 账户权限。
4. 按需勾选复用本机 skills、规范，并设置默认引擎。新对话也可单独选择引擎；历史对话保留创建时的引擎和版本，不随默认选择切换。

内置可校验版本为 Codex 0.164.0、Claude Code 2.1.310；点击“检查在线版本”获取 Codex 最新稳定版、Claude latest/stable，选择目标后在线安装。下载和离线导入均校验摘要、版本及隔离账户探测，校验失败不发布活动索引。插件包不包含引擎程序。更新保留旧版本，已有会话按启动快照使用原版本。

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

“移除引擎”只移除活动索引，保留版本程序、授权、配置和历史；固定旧版本的历史仍可读取对应版本。插件 ID 和 dataVersion 保持不变。

## 协作协议

Codex 使用原生 app-server 协议；Claude Code 使用原生双向 stream-json 协议，由插件适配到现有对话、审批、提问和中断事件。Claude 的工具审批不会自动放行。Claude 会话恢复使用原生 session ID，终端模式暂不支持分叉。

结构化 AI 对话通过仅监听本机回环地址、逐会话随机令牌保护的 MCP 网关发现工作台能力，调用继续经过工作台能力协议。终端通过 MCP 插件的公开启动配置接入服务；全局对话通过工作台能力网关接入，两条链路均应用当前引擎的 MCP 选择。

## 验证与限制

历史验收记录及离线包摘要保存在本机 `plugin-dev/dist/verification/`，不随源码提交；不同版本的验收范围须分别核对。Codex 已完成真实云端对话和工作台工具调用；Claude Code 已完成真实程序安装、隔离账户与原生工具发现，尚未完成需要 Claude 登录授权的云端模型调用。两个引擎的浏览器登录完成步骤仍需用户实际授权。

## 新配置页

插件配置提供“引擎与账户 / MCP 服务 / 模型供应商”三页，顶部引擎选择仅切换当前配置对象，不改变已经打开的对话。

MCP 默认自动使用所有已启动服务；关闭自动选择后可逐项勾选并保存，空列表表示不接入 MCP 服务。服务由公开能力协议发现，停止的服务不会伪装成可用；历史选择的服务不可用时明确报错。服务部署与密钥仍归 MCP 插件管理。

供应商可按引擎添加、编辑、测试及启用。Codex 要求 Responses API，Claude Code 要求 Anthropic Messages。OpenAI、Anthropic、DeepSeek、千问、Kimi 模板用于填写接口，不保证任意模型与引擎兼容；仅有 Chat Completions 的接口不能直接用于 Codex。Claude 官方网关支持范围仍以其文档为准。

密钥保存于插件数据根目录的 providers.json（0600），后端读取列表不返回密钥。编辑时留空保留旧密钥，勾选清除才删除。测试连接会向供应商发起一次小请求并可能产生费用，仅测试接口协议；不代表引擎工具调用已经通过。选择供应商应用于新进程，运行中的会话保持原配置。历史保存非密钥快照，恢复时按供应商 ID 读取当前密钥；删除供应商后需重新配置，不能静默切到其他模型。

本次实际验证结果见 [配置改造验收](ai-agent-settings-verification.md)。包由用户自行导入，未自动改动正式安装目录或用户数据。


## Agent 会话协作（0.6.79）

原生 Codex、Claude Code 终端通过逐会话认证的内置 MCP 服务 `desk_agent_sessions` 使用以下工具：

- `agent_sessions_list({})`：发现当前工作台其他已打开的 Agent 会话，返回名称、引擎、工作目录、状态、暂停原因和排队数。
- `agent_session_send({targetId,requestId,text,files?,replyTo?})`：发送消息及本地文件副本；requestId 由发送方生成且重试保持不变，files 使用绝对路径。
- `agent_messages_read({messageId?})`：查询自己的收发记录及回执；回复时使用 send 并填写 replyTo。

空闲且原生输入区为空时自动继续，每轮只提交一条；忙碌按 FIFO 排队。权限、普通文字追问、用户草稿、附件、输入法组合输入、断网或未知输入区均暂停。多客户端中任何一个有草稿都暂停。消息明确标注来自另一 Agent，不能作为用户授权或确认。

工作台提供通用路由、持久化回执和文件快照，AI 插件负责业务调度；文件摘要、容量和保留期遵循 `desk.channels.v1`。归档后从发现列表移除但保留 pending，恢复同一卡片继续排队；永久删除使其 pending 失败。崩溃后的 uncertain 不自动重发，delivered 仅表示原生终端输入已提交。

工具在新会话或现有安全重连流程中注入，升级不强制重启正在工作的会话。自动投递复用现有 MCP 上游连接；若连接需要重新解析，返回 connection_refresh_required，等待现有用户输入或重连刷新。不会伪造用户父调用，也不放宽宿主服务限制。

本版要求包含 `desk.channels.v1` 的更新宿主。隔离验证覆盖认证 MCP SDK 双向工具调用、文件副本及回执；实际 Codex 0.166.0、Claude Code 2.1.310 在临时配置中验证了空输入识别和草稿保护。未使用真实密钥触发模型自主调用，不能将上述结果视为真实模型协作验收。
