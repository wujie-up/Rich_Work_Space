# MCP 服务开发与部署规范

MCP 服务不是桌面插件，不需要制作 `.plg`。开发者交付标准 stdio MCP 服务代码，由 MCP 插件托管；桌面插件之间仍通过通用服务契约发现。

## 本地服务

首版支持 Python（`.py`）和 JavaScript（`.js`、`.mjs`、`.cjs`）。支持粘贴单文件、导入脚本、导入 UTF-8 文本服务目录。目录中的相对引用会保留。单文件不超过 4 MiB，合计不超过 16 MiB，最多 2000 个文件。不要导入密钥、`.env`、虚拟环境、Git 数据或编译产物。带二进制依赖的环境应在本机预先准备。

推荐目录：

```text
sls-mcp/
  mcp-service.json
  server.py
  requirements.txt
```

`mcp-service.json` 是可选的部署声明，只声明字段，不携带配置值。导入目录时自动填充名称、语言、入口和配置表单：

```json
{
  "name": "SLS 日志查询",
  "description": "只读查询阿里云 SLS 日志，支持关键字、SQL、时间范围和分页。",
  "language": "python",
  "entry": "server.py",
  "fields": [
    { "name": "SLS_ENDPOINT", "label": "SLS 地址", "required": true },
    { "name": "ALIBABA_CLOUD_ACCESS_KEY_ID", "label": "AccessKey ID", "required": true },
    { "name": "ALIBABA_CLOUD_ACCESS_KEY_SECRET", "label": "AccessKey Secret", "secret": true, "required": true },
    { "name": "SLS_PROJECT", "label": "项目", "required": true }
  ]
}
```

MCP 服务页面右上角的压缩包图标支持直接导入 ZIP，旁边的加号添加空白服务。ZIP 必须包含一份 `mcp-service.json`，位于根目录或唯一的外层目录中，并包含声明的入口和相对依赖文件。导入后进入新服务配置，补齐本机环境变量并保存后创建；不自动启动或覆盖已有服务，不会将包内的环境变量值、命令或解释器路径自动应用为本机配置。支持 Jenkins、feishu-doc 等已生成的服务包；外部运行库仍需预先准备。

压缩包最多 20 MiB，解压后最多 16 MiB、2000 个 UTF-8 文本文件，单文件最多 4 MiB；不接受加密包、链接、特殊文件或越界/重复路径。有 `integrity.json` 时校验 SHA-256 文件清单；所有导入文件还校验 ZIP CRC。导入校验在插件视图中完成，不写入临时安装目录或执行包内代码。

所有服务类型均可填写可选的“功能描述”，最多 2000 字符，用于说明具体能力和操作范围；ZIP 声明的 `description` 会自动带入配置。功能描述保存在该服务的本机元数据中，修改它不改变代码或凭据；配置页保存仍沿用原有的服务停用规则。

JavaScript 将 `language` 改为 `javascript`，入口改为相应脚本。ES Modules 推荐使用 `.mjs`；使用 `.js` 时在同目录 package.json 中声明 `"type": "module"`。直接粘贴代码时，可展开“配置字段声明”填写相同的 fields 数组，点击“应用字段”，再填写参数。字段名称必须是唯一的环境变量名称。

运行环境可填写 `python3`、`node` 或可执行文件绝对路径，不接受带参数的命令字符串。Python 建议使用已安装依赖的虚拟环境解释器，例如 `/path/to/venv/bin/python`。JS 导入的目录应包含所需的纯文本模块及兼容的依赖；需要 npm 安装或原生模块时，先在外部准备可运行目录，再用“外部 stdio”注册该目录、命令与参数。本版不自动安装 Python/npm 依赖，也不下载解释器。

代码通过 `os.environ["SLS_ENDPOINT"]`（Python）或 `process.env.SLS_ENDPOINT`（JS）读取配置。服务应按标准 MCP stdio 协议工作，stdout 只输出 JSON-RPC 行；业务日志写 stderr。普通请求及启动握手期限为 18 秒，单次消息/结果不超过 1 MiB。查询工具参数应使用明确的 JSON Schema，不应让 Agent 提供服务密钥。

依赖准备好后点击保存，再启用供 AI 使用。点击调试可用当前未保存的代码和配置，由 AI 发现并调用工具；无需填写工具名或 JSON 调用参数。启动失败可查看日志。运行中可直接保存修改，有效配置通过校验后停止旧实例，再手动启用；无效配置不影响运行实例。新代码保存为独立修订，配置保存在 services.json，旧修订保留。服务代码在本机有用户权限，仅导入可信代码；独立进程提供故障隔离，不是恶意代码沙箱。

## 第三方转接

选择远程 Streamable HTTP，填写远程 MCP URL、Bearer Token 或高级请求头。本地服务的“业务地址”是传给业务代码的配置；这里的 URL 是已经部署的 MCP 协议入口，两者不同。兼容 2025-11-25 会话型协议，不支持旧 SSE 专用入口和 OAuth 登录流程。

## Agent 发现

启动成功后，每个服务通过工作台发布工具说明、调用工具两个能力。AI 按需读取真实工具说明后决定调用；页面加载、保存与启用均不预读工具。既有 `mcp.connections.v1` 本机认证网关及 `agent.launch-config.v1` 启动配置继续兼容。独立 AI 对话沿用工作台能力网关。调试只暴露目标临时服务，正式对话看不到临时能力。

AI 仅收到本机网关 URL 和临时认证令牌，不收到业务密钥或上游认证信息。每个 MCP 客户端获得独立 stdio 进程或上游连接：服务不能假设所有客户端共用内存状态。停用后网关关闭，现有连接断开，新会话不再注入该服务。

配置值目前以本机文件保存，未做系统钥匙串加密。日志对已配置环境变量值和认证请求头脱敏；服务自身不得将密钥编码后返回给工具调用方。保留数据升级会保留注册记录、代码修订、配置和日志；手动停用清除期望运行状态；工作台重启时恢复期望启用的正式服务。
