# SLS 日志查询 MCP 服务

基于本机已验证的 `sls-prod-triage` 查询、签名和脱敏规则编写。仅使用 Node.js 22 内置模块，无需安装 npm 包、Java 或 Python。服务本身不会读取 skill 或业务仓库。

## 部署与配置

在 MCP 插件添加“部署 Python / JavaScript”服务，导入此目录，选择 `server.mjs` 为入口，运行环境填写 Node.js 的绝对路径。目录中的 `mcp-service.json` 声明配置表单，不包含密钥。

填写 SLS 区域地址、AccessKey ID、AccessKey Secret，使用 STS 时再填写 Token。Project、Logstore 为可选默认值，调用方可分别传入 `project`、`logstore` 覆盖；未配置默认值时必须在调用时传入。一个实例可查询所配置区域内、当前凭据有权限访问的所有 Project / Logstore，不会绕过阿里云权限，也不跨区域自动发现。密钥保存在本机 MCP 插件配置中，不写入代码或服务压缩包。

保存并启用后可发现 `sls_query`。已启动的服务自动提供给 AI Agent；新建、恢复或分叉 Codex 会话时加载。运行中的会话不会热更新。

## 查询示例

字面搜索（默认最近 15 分钟、20 行）：

```json
{"term":"订单号或错误关键字","minutes":15,"lines":20}
```

指定其他 Project 和 Logstore：

```json
{"project":"ai-ve","logstore":"app","term":"订单号或错误关键字","minutes":15,"lines":20}
```

并发调用各自使用独立的目标地址，不会改变其他调用或服务默认值。

统计查询：

```json
{"query":"* | select count(*) as matched_logs limit 1","minutes":5,"lines":1}
```

固定时间范围与搜索分页：

```json
{"term":"ERROR","from":"2026-10-24T10:00:00+08:00","to":"2026-10-24T10:05:00+08:00","lines":20,"offset":20}
```

`term` 和 `query` 二选一。时间戳使用 Unix 秒，ISO 时间必须带时区。搜索每次最多 100 行，分页必须复用首条结果的 `from` / `to`。SQL 必须以 `LIMIT 1..100` 结尾；轻量实现不接受 SQL 注释、多条语句或 SQL 分页，需缩小时间范围或改用搜索分页。

返回包含实际查询的 Project / Logstore、请求 ID、时间范围、查询耗时、重试次数和 `progress`。`Incomplete` 最多重试三次，仍为 `Incomplete` 或 `Unknown` 时不能视为完整结果。服务复用 HTTPS 连接并校验 TLS，只调用只读 GetLogs 接口。

## 脱敏与验证

配置密钥、常见结构化敏感字段及内嵌的凭证会被脱敏；自由文本中的敏感信息无法保证全部识别，展示业务日志前仍需核查。

本地回归：`node --test plugin-dev/mcp/examples/sls/server.test.mjs`。签名对照测试使用本机现有 Python skill，实际部署的服务不依赖它。显式联网验证脚本为 `plugin-dev/mcp/test/sls-real.manual.mjs`，只执行短时间窗口的聚合计数，不拉取业务原始日志。
