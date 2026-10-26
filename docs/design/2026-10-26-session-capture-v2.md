# 按窗口和对话抓取 Agent 请求

授权：用户选择“Agent 窗口/实例 → 窗口内多个对话”，并明确允许扩展 AI 插件。

目标：抓包插件选择已登记窗口，再选择具体对话，点击开始后只记录该对话。AI 插件管理窗口归属、Codex/Claude 原生接入、代理和本地日志；抓包插件通过公开服务完成发现、控制和分页读取。账号与上游从抓包 UI 移除。

沿用独立插件路线。将既有代理和日志能力移动到 AI 插件，不另建平行实现；保留旧插件 ID codex-capture 和旧日志目录。新包显示名 Agent 抓包，版本 0.2.0；AI 版本 0.6.0。AI 服务 agent.capture.v2 的 catalog/configure/status/list/read 操作携带运行实例 ID、窗口 ID、对话 ID；日志不作为目录元数据广播。

每个 AI 对话视图生成并登记稳定于该 frame 重载的 window.name ID，新对话保存 windowId；窗口历史只显示自己的对话和未归属旧对话。旧对话首次被明确选择时归属该窗口，禁止抢占其他窗口的对话。历史未归属记录单独分组；不删除旧记录。

接入只在 Conversations.connect 的轮次边界应用，不在 EngineManager.launch 全局应用，不影响登录、模型列表或未选中对话。选中已有对话在下一轮恢复同一原生 thread/session。关闭记录只停写日志，AI 代理继续转发；关闭 AI 才清理其代理。抓包消费者每 5 秒续租，20 秒失联停录，防止抓包插件崩溃后无限继续记录。

Codex 用 openai_base_url，AI 插件读取自己 profile 的认证类型自动选择官方 ChatGPT/API 上游。Claude 用 ANTHROPIC_BASE_URL 保留原生认证，限制官方 Anthropic 路径；第三方 provider、自定义 CLI 明确不支持。不修改永久配置、认证、系统代理/证书或 desk。

文件范围：AI 插件的 conversations.js、index.js、engines.js、原 capture-route.js 和对应测试、renderer/conversation.js、resource/conversation.html、build/build.mjs、版本和依赖文件；新增 AI capture/ 内代理/日志/管理器和测试。抓包插件入口、renderer、HTML、构建、版本、README 和测试；删除已迁移的网络实现。文档在 docs/design 与 docs/superpowers/plans 新增本任务文件。分三批，每批聚焦一个行为并测试；不提交、不覆盖安装。

验收：两个窗口、多个 Codex/Claude 对话不串包；旧对话保留、归属持久化；下一轮接入同一线程；实例变化/失联/旧插件显示明确错误；停录与进程清理、真实本地 HTTP/SSE/WS、浏览器 UI 和新包验证；受管 Codex/Claude 使用合成账号、本地服务探测，不使用真实模型费用。
