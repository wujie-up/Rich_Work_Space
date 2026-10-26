# Agent 抓包 0.2.0

配套 AI Agent 会话 **0.6.0**。抓包目标为 **Agent 插件窗口/会话分组 → 具体对话**，支持受管 Codex 与 Claude Code。独立抓包插件仅发现目标、控制和查看；接入、上游、认证适配及日志由 AI 插件管理。

## 使用

1. 结束正在执行的任务，按 Work Desk 保留数据升级流程导入 `ai-agent-sessions-0.6.0.plg` 与 `codex-capture-0.2.0.plg`。插件 ID 沿用 `codex-capture`，显示名更新为 Agent 抓包。
2. 打开 AI 对话窗口。顶部可见该窗口的分组编号和 ID；每个窗口可包含多个对话。窗口分组下拉可重新打开历史窗口的对话，原有未归属对话可从历史列表选择并归入当前窗口。
3. 打开 Agent 抓包，点击刷新目标，依次选择 **Agent 窗口**、**具体对话**，点击开始记录。
4. 向所选对话发送消息。已运行对话在下一轮恢复原 thread/session 并接入，不中断当前轮次；界面明确显示等待接入、已接入、已捕获或目标失联。
5. 切换目标时停止原目标记录，只抓所选对话。停止记录或关闭抓包插件不会关闭 Agent 引擎；失联 20 秒后记录租约自动到期。AI 插件关闭时才释放其代理。

旧 AI 插件没有公开会话接口时，界面会提示升级，不再把插件已开启显示为抓包成功。自定义 CLI、旧终端模式和第三方 provider 尚不支持自动抓包，不伪造支持状态。

## 数据与边界

日志在 AI 插件自身数据目录 `plugin-data/ai-agent-sessions/capture/<对话ID>/<请求ID>.jsonl`，窗口显示实际路径。Authorization、Cookie、Set-Cookie、API key 和 token 类请求头脱敏；正文按实际传输保存，不能保证识别正文中人为粘贴或上游回显的秘密。

HTTP 原始块保存为 base64，支持的编码额外输出解码文本；WebSocket 按消息记录。界面列最近 200 条、每页读取 64 KiB、只显示最近 2 MiB；完整日志留在磁盘，不自动清理。WS 单条消息上限 64 MiB。旧版抓包插件目录中的日志原样保留，新界面不会混入无会话归属的旧日志。

不修改系统代理、证书、永久 CLI 配置或凭据。Codex 根据 AI 自己 profile 的认证类型选择官方 API/ChatGPT 上游；Claude 采用官方 Anthropic Messages 接口；代理沿用已存在的引擎网络环境。公开服务 `agent.capture.v2` 校验 Agent 运行实例、窗口及对话归属，目录仅返回元数据，正文经明确选择后分页读取。

## 开发与验证

先在 `plugin-dev/ai-agent` 运行 `npm ci --ignore-scripts`，然后在仓库根运行 `npm run build`。再运行 `npm run pack:plugin -- desk/dist/plugins/ai-agent` 和 `npm run pack:plugin -- desk/dist/plugins/codex-capture`，输出到 `plugin-dev/dist/`。

- 领域与契约测试：`node --test plugin-dev/ai-agent/test/*.test.js plugin-dev/codex-capture/test/*.test.js`
- 浏览器界面及历史分组：`node plugin-dev/codex-capture/test/ui.manual.mjs`
- 包及后台隔离：`node plugin-dev/codex-capture/test/package-probe.mjs`
- Codex 原生探测：`node plugin-dev/ai-agent/test/capture-native-probe.mjs <受管Codex路径> api` 或 `chatgpt`
- Claude 原生探测：`node plugin-dev/ai-agent/test/capture-claude-probe.mjs <固定版本离线包路径>`

原生探测仅使用临时合成凭据和本地模拟服务，Claude 从离线包临时提取并校验 SHA-256，不安装覆盖用户引擎，不调用真实付费模型。真实账号与实际用户桌面的端到端联调不包含在这些结果中。
