# 线上数据库查询 MCP · Metabase

独立 stdio MCP 服务，基于给定的 `POST /api/dataset` 请求，向 Agent 提供 `metabase_databases` 和 `metabase_query`，自动发现数据库并缓存。使用 Node.js 22 内置模块，无第三方依赖；不修改桌面宿主、MCP 插件或其他业务插件。

## 在 DeckPg 中配置

1. MCP 插件 0.4.9 及以上版本新增或编辑服务，类型选择“Python / JavaScript”，语言选择 JavaScript，入口填写 `server.mjs`，将本目录 `server.mjs` 的完整代码粘贴到“服务代码”。
2. “运行与导入设置”中填写 Node.js 22 的绝对路径（终端 `command -v node` 查看）。
3. 展开“环境变量”，填写以下 JSON；账号密码仅在本机填写，不要改源码、示例或压缩包：

```json
{
  "METABASE_URL": "https://bi.dbaifin.com",
  "METABASE_USERNAME": "在本机填写登录账号",
  "METABASE_PASSWORD": "在本机填写登录密码"
}
```

4. 保存并启用。Agent 发现两个工具后即可调用；新建或恢复 Agent 会话时加载启用的服务。已有会话未发现时重新打开该会话。

`METABASE_URL` 默认就是上述地址；无需配置 `METABASE_DATABASE_ID`，旧配置中的该变量不再使用。首次调用自动通过 `GET /api/database` 获取当前账号可访问的数据库。只有一个库时自动使用；多个库时由 Agent 根据排障场景选择列表中的完整库名，同一个服务即可查询多个库。

首次调用没有 Session 时，服务以环境变量中的账号密码请求 `POST /api/session`。获得的 Session 仅保存在进程内存中，后续请求使用 `X-Metabase-Session`。收到 401 时自动重新登录，只重试被拒绝的请求一次；登录失败、重试仍返回 401、权限不足 403 或网络错误直接报错，不循环登录或重试查询。登录、数据库发现、查询与认证恢复共用 15 秒超时。账号必须支持 Metabase 用户名密码登录，SSO/MFA 交互不在本服务范围内。

兼容已有 `METABASE_SESSION`：配置了 Session 时优先使用；同时配置账号密码即可在失效后恢复。只配置 Session 则保持原有行为，失效后需手动更新。账号密码必须成对填写，密码中的空格会原样发送。变量经环境注入 `process.env`，不替换或拼接进 JavaScript 源码。

其他 MCP 客户端可参考 `stdio.example.json`，替换可执行文件、入口绝对路径及本机账号密码；仍可使用 stdio 环境变量运行。`mcp-service.json` 仅声明字段，未携带配置值。本服务不是桌面插件，无需重装 DeckPg；环境变量编辑入口由 MCP 插件 0.4.9 提供。

## Agent 使用示例

先调用 `metabase_databases`（参数 `{}`），获取库名和 ID；多库时根据排障场景选择，不能猜测。列表仅缓存 ID、名称和引擎，保存在服务进程内存中 5 分钟；过期后下次调用重新获取，重启也重新获取。传入 `{"refresh":true}` 可立即刷新。刷新失败不回退旧缓存，401/403 会清空缓存；不缓存业务查询结果。

再调用 `metabase_query` 验证连接（不读取业务数据）。以下 `database` 替换为列表返回的完整库名；只有一个库时可省略：

```json
{"database":"从 metabase_databases 返回的完整库名","sql":"SELECT 1 AS connectivity_check","limit":1}
```

查看表字段，避免直接读取整表：

```json
{"database":"从 metabase_databases 返回的完整库名","sql":"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'financial' AND table_name = 'payment_channel_config' ORDER BY ordinal_position","limit":100}
```

按国家检查配置；实际排障建议从表结构中选出必要字段，避免 `*`：

```json
{"database":"从 metabase_databases 返回的完整库名","sql":"SELECT * FROM financial.payment_channel_config WHERE country_code = 'BR'","limit":10}
```

返回 `columns`、二维 `rows`、`row_count`、`limit`、`truncated`、实际查询的数据库 ID `database`、本次本地 `request_id` 和耗时。命中行数上限时保守标记 `truncated: true`，不能据此推断完整数量，需缩小条件或做聚合。查询失败通过 MCP `isError` 和错误代码返回，不把失败当作空结果。

## 执行边界

- 仅支持单条 SELECT，自动补充 LIMIT，默认 20 行，上限 100。显式 LIMIT 也被工具参数收紧，并发送 Metabase 行数限制。
- 保守检查拒绝注释、多语句、CTE、写入、锁定、变量、反斜线转义、嵌套 LIMIT、OFFSET 和白名单之外的函数。不支持复杂方言；常见聚合、日期、字符串和 JSON 函数可用。
- **必须使用数据库侧只读账号和最小范围的 Metabase 查询权限。** SQL 过滤是减少误操作的辅助措施，不能作为权限隔离或任意 SQL 安全证明。视图和数据库函数的真实行为取决于线上数据库。
- 单进程同时只执行一个请求；登录、数据库发现和查询共用 15 秒超时，仅在明确返回 401 时认证恢复并重试一次。网络中止不保证数据库端取消；LIMIT 也不限制扫描量，排障应按订单/用户/国家/时间过滤，数据库侧应配置语句超时。多个客户端可能使用独立进程。
- HTTPS 校验证书，不跟随重定向。上游响应最多 1 MiB，输出结果最多 256 KiB；超限明确失败，避免越过工作台的 1 MiB 消息限制。
- 常见密码、令牌、密钥、手机、邮箱等列，以及 JSON 配置字段中的同名键会脱敏；配置的密码、初始 Session 和当前 Session 出现在返回结果中时会隐藏。无法保证识别别名或任意自由文本中的全部敏感信息，仍应主动缩小查询字段。
- stdout 只输出 MCP JSON-RPC；stderr 仅记录服务名、工具名、数据库 ID、本次请求 ID、状态及耗时，不记录 SQL、凭据、业务行或上游原始错误。

本机 MCP 配置含凭据，不应提交、打包或公开。源码和交付目录只包含占位示例。

## 验证

```sh
node --test plugin-dev/mcp/examples/metabase/*.test.mjs
```

覆盖自动发现、缓存命中/过期/刷新、库名与 ID 选择、权限失效清理、请求契约、SQL 限制、权限/登录错误、脱敏、结果限制、超时、并发及 MCP 握手/工具调用。模拟测试不访问线上数据库；线上连接验证只调用 `SELECT 1`。

接口参考：[Metabase 官方 API 使用说明](https://www.metabase.com/learn/metabase-basics/administration/administration-and-operation/metabase-api)。Metabase API 不固定版本，升级后应重新验证请求和响应结构。
