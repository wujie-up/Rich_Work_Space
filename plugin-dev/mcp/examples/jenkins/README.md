# mcp-jenkins 1.1.0 · 部署与结果回查

独立 stdio MCP 服务，提供 `jenkins_deploy` 触发部署，以及 `jenkins_deployment_status` 只读回查本次部署结果。支持无参数和参数化构建、文件夹中的 Job。运行环境为 Node.js 22+，仅使用内置模块，不需要 npm 安装。

不提供任务列表发现、日志查询、取消、定时部署或监听代码变更。不会创建或修改 Jenkins Job。

## 导入与配置

1. 解压 `mcp-jenkins-1.1.0.zip`。
2. 在工作台 MCP 插件添加本地 JavaScript 服务，使用“导入服务目录”选择解压得到的 `mcp-jenkins`。入口为 `server.mjs`，声明文件 `mcp-service.json` 会自动填入服务信息。
3. 运行环境填写 Node.js 22+ 的可执行文件绝对路径。在“环境变量”填写以下 JSON，并将账号密码替换为本机实际值：

```json
{
  "JENKINS_URL": "http://192.168.3.21:8080/",
  "JENKINS_USERNAME": "在本机填写账号",
  "JENKINS_PASSWORD": "在本机填写密码"
}
```

4. 保存并启用服务；在 AI 会话中选择此 MCP 服务。已有会话需要新建或恢复后加载工具。

账号密码必填，密码中的空格原样保留。地址为空时默认 `http://192.168.3.21:8080/`；也可填写参考页面 `http://192.168.3.21:8080/view/co/`，服务会将该视图地址转换为 Jenkins 根地址。支持 `/jenkins/` 等上下文路径。

配置通过环境变量传给独立服务进程，凭据不进入代码、交付包或工具调用参数。配置由现有 MCP 插件保存在本机，当前没有钥匙串加密；`secret` 是字段声明，不代表本机存储加密。更换密码时在 MCP 服务配置中修改并重新启用。HTTP 地址沿用给定的内网服务，若 Jenkins 提供 HTTPS，可直接改用 HTTPS，服务保持证书校验。

其他 MCP 客户端参考 `stdio.example.json`，替换运行环境和脚本绝对路径，在本机配置账号密码。

## 触发工具：jenkins_deploy

只需提供真实 Job 名。服务会读取该 Job 的参数定义和运行状态，自动选择 `/build` 或 `/buildWithParameters`。

```json
{"job":"your-deploy-job"}
```

需要覆盖默认参数时提供 `parameters`。参数名称和取值必须与现有 Jenkins Job 的真实定义一致；以下名称仅为示例：

```json
{"job":"folder/your-deploy-job","parameters":{"BRANCH":"main","ENV":"fat","DRY_RUN":false}}
```

使用默认参数可省略 `parameters`，也可传空对象；服务自动识别 Job 类型：

```json
{"job":"your-deploy-job","parameters":{}}
```

`job` 使用实际完整路径，`/` 分隔文件夹；视图 `co` 是任务列表分组，不代表 Job 路径，不要根据页面地址自动添加 `co/`。不支持把 URL、已经百分号编码的路径、文件参数或对象/数组参数传给工具。含 `/` 的多分支分支名无法通过本版本的斜杠分隔格式表达。最多 100 个标量参数，单个字符串最多 16384 字符，表单编码后的参数合计最多 128 KiB。

仅当用户明确要求部署目标 Job 和对应参数时调用。提交前校验未知参数名、Jenkins 导出的选项值、布尔值，以及没有默认值的缺失参数；缺失参数以 `missing_parameters` 返回，不返回默认密码或原始配置。动态分支、环境是否真实可用仍由 Jenkins 自身判断，服务不额外枚举远程仓库。

已排队、已有构建正在执行或已停用的 Job 不重复触发。使用 `allBuilds[building]` 检查历史中仍在运行的并发构建，响应上限 512 KiB；无法完整检查时明确拒绝，不根据截断数据猜测空闲。这是提交前的状态检查，不能替代 Jenkins 自身的并发配置，也不能保证不同客户端同时提交时的原子去重。

## 返回语义

- `status: "submitted"`：Jenkins 返回 201/202，表示已接收请求，**不代表部署完成或成功**。返回目标 `job`、`job_url`；响应携带合法的同站点队列地址时返回 `queue_id`、`queue_url`，并用最多一秒的一次只读查询尝试补充 `build_number`、`build_url`。补充信息失败仍保留 `submitted`，不会再次触发。
- `status: "error", submission: "not_sent"`：认证、CSRF、连接、参数或并发检查未通过，尚未发送部署 POST。工具参数格式错误以 MCP `isError` 返回。
- `status: "error", submission: "rejected"`：Jenkins 对部署 POST 返回明确的 400/401/403/404/405 拒绝响应。
- `status: "error", submission: "unknown"`：发送部署 POST 后超时、连接中断、重定向、5xx 或其他非预期响应；可能已经入队，须在 Jenkins 页面核实，**禁止自动重试**。

一次调用最多提交一个 POST，不自动重试，不跟随重定向。认证和触发共用 15 秒超时，避免等待部署完成超过宿主工具调用期限；同一服务进程同时只接受一个部署调用，不同 MCP 客户端可能运行独立服务进程，不提供跨客户端去重。

## 完成状态工具：jenkins_deployment_status

触发后，调用方必须使用本次触发返回的 Job 和队列 ID 回查；已取得构建号时优先使用构建号，避免队列记录过期。两个标识只能提供一个，不能用其他部署的标识代替：

```json
{"job":"your-deploy-job","queue_id":123}
```

```json
{"job":"your-deploy-job","build_number":11}
```

回查流程：

1. `queued` / `running`，且 `completed: false`：按 `poll_after_seconds`（5 秒）等待后继续查询本次部署。
2. `completed: true`：按 `result`、`duration_ms`、`build_url` 汇报最终结果。`SUCCESS` 对应 `succeeded`；`FAILURE`、`UNSTABLE`、`ABORTED`、`NOT_BUILT` 分别返回明确终态，不能统称成功。队列中被取消返回 `cancelled`。
3. `status: "error", completed: false`：查询认证、记录或网络异常，最终结果尚未确认。不能当作构建失败或成功，不能自动重新部署。队列记录过期且没有已取得的构建号时，返回记录不可用；不回退到“最新构建”。

工具按队列所属 Job、队列 ID、构建号及构建所属队列核对身份，避免同名或其他轮次的构建串结果。查询只使用 GET，不发送部署请求。每次查询最多 15 秒，不把分钟级构建阻塞在一次 MCP 请求中；由 Agent 根据工具说明持续回查并汇报，服务不会在会话断开后独立推送通知。Jenkins 的 SUCCESS 表示该 Job 执行成功，服务不额外探测部署后站点的业务健康。

使用 HTTP Basic 账号密码认证。每次触发前从 `/crumbIssuer/api/json` 取得 crumb，并携带同一次响应的会话 Cookie 提交；crumb 入口返回 404 时按未配置 crumb issuer 处理，Jenkins 仍负责验证权限。SSO/MFA 交互登录不在本服务范围内。stdout 仅输出 MCP JSON-RPC，stderr 只记录服务、工具、请求 ID、状态和耗时，不记录密码、Authorization、Cookie、部署参数或 Jenkins 原始响应正文。

## 验证

在仓库根目录执行：

```sh
node --check plugin-dev/mcp/examples/jenkins/server.mjs
node --test plugin-dev/mcp/examples/jenkins/*.test.mjs
```

自动测试使用本地 HTTP Jenkins 模拟服务，包括真实 MCP SDK stdio 调用和工作台 MCP 部署管理器的导入、启动、调用、重启及保留配置升级契约，不访问实际 Jenkins。此前 1.0.1 已经用户授权实际触发 `dev-saas-admin` #295，Jenkins 最终返回 SUCCESS，耗时 118105 ms。1.1.0 更新验收只回查已存在的构建，不另行触发真实部署。

本服务按 `docs/mcp-service-development.md` 作为独立 MCP 代码交付，不是桌面插件，无需制作 `.plg` 或更新工作台。包中仅包含 `server.mjs`、`mcp-service.json`、`stdio.example.json`、本说明及 SHA-256 文件清单。

接口依据：[Jenkins Remote Access API](https://www.jenkins.io/doc/book/using/remote-access-api/)、[Jenkins CSRF Protection](https://www.jenkins.io/doc/book/security/csrf-protection/)。
