# Codex 请求抓包

用户已确认：Work Desk 独立插件，加 AI 插件最小代理接入。

目标：启用后，后续启动的受管 Codex 引擎经过仅监听 127.0.0.1 的本地代理；打印请求和响应到插件独立日志，并提供实时查看。正文保留实际传输内容，认证头及 Cookie 脱敏。SSE 逐块转发，WebSocket 逐消息转发。关闭记录后现有连接继续转发，禁用插件将关闭代理，已接入引擎需要重新启动。

边界：不修改 sl-platform、desk 宿主、系统代理、证书、用户认证和永久 Codex 配置。不拦截其他应用，不还原服务端引用或加密内容。首次支持内置 OpenAI provider；上游在 ChatGPT 与 OpenAI API 间显式选择，默认 ChatGPT。已有运行引擎不热改路由。

对比：系统 HTTPS 中间人代理需要证书和全局路由，影响面更大；选用受管引擎临时 base_url + 独立本地代理。插件之间通过 agent.capture-route.v1 服务交互，不互相导入。

文件范围：新增 plugin-dev/codex-capture/{plugin.json,package.json,package-lock.json,README.md,build/,ico/,src/,test/}；AI 插件新增 capture-route.js、对应测试，修改 engines.js、index.js 及版本清单。文档仅在 docs/design/ 和 docs/superpowers/plans/ 新增本任务文件。源码仓库已有大量未提交改动，直接在已授权范围最小增量实现，保留已有内容，不提交或安装覆盖运行版本。

验收：真实本地上游验证 HTTP 请求不变、SSE 首块及时返回、WS 消息、错误与取消、停录继续转发、路由隔离、脱敏和日志读取；受管 Codex 使用合成认证验证其实际请求命中本地入口；AI 领域回归、构建、打包及 diff 检查。不会使用真实账号产生模型费用。
