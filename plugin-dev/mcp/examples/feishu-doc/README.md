# feishu-doc 1.0.0

独立 stdio 飞书文档 MCP 服务，复用官方 `@larksuiteoapi/lark-mcp@0.5.1`，沿用 OAuth 用户授权方式，固定只启用两个只读 API：

- `docx.v1.document.rawContent`：读取新版文档正文。
- `wiki.v2.space.getNode`：解析 Wiki 节点；取得 docx 的 `obj_token` 后再读取正文。

工具的实际 MCP 名称、参数 Schema 和返回格式由该固定版本官方运行库提供，通过 `tools/list` 发现后调用。不包含文档写入、消息发送、通讯录或其他 preset 工具。保持飞书自身的应用权限和用户文档权限检查，不绕过授权。

## 工作台配置

导入本目录，入口 `server.cjs`，运行环境选择 Node.js 22+。官方运行库及其生产依赖需预先准备，`FEISHU_DOC_ENGINE_DIR` 指向包含 `package.json` 和 `dist` 的 `@larksuiteoapi/lark-mcp` 包目录。

```json
{
  "APP_ID": "在本机填写应用ID",
  "APP_SECRET": "在本机填写应用密钥",
  "FEISHU_DOC_ENGINE_DIR": "/absolute/path/node_modules/@larksuiteoapi/lark-mcp",
  "FEISHU_DOC_DATA_DIR": "/absolute/path/to/owned/feishu-doc-data"
}
```

本次迁移经用户确认，以本机 `~/.codex/config.toml` 中现有 `lark-mcp` 为来源，仅将 APP_ID、APP_SECRET 复制到 MCP 插件配置。原配置、skill、全局 hooks、其他服务配置及 OAuth token 缓存均不修改、不导入。原版官方运行库和生产依赖复制为 MCP 插件数据目录下的独立副本，运行时不依赖临时 npm 缓存、系统 Agent CLI 或在线 npx 下载。

数据、授权缓存、日志目录及系统钥匙串命名空间与原 lark-mcp 分开。OAuth 首次使用可能需要重新登录；回调沿用官方默认 `http://localhost:3000/callback`，应用开放平台的回调配置须允许该地址。若端口被另一登录流程占用，先完成或关闭那次登录再重试。服务不会主动发送消息或修改文档。

也可在配置中显式填写 `USER_ACCESS_TOKEN`，此时关闭 OAuth 交互并仅使用该用户令牌；过期后需本机更新。不会回退到租户令牌读取文档。App ID 和 App Secret 仍为官方运行库要求的必填项。

保存并启用后，在新建或恢复的 AI 会话中选择该服务。仅启动和工具发现不会读取文档；首次实际调用需要用户文档权限。长时间未完成 OAuth 可能超过宿主 18 秒调用期限，完成授权后明确重试读取。

MCP 插件当前将环境变量保存在本机配置文件，`secret` 字段不代表系统钥匙串加密；官方 OAuth 存储使用独立的钥匙串加密密钥。交付包只包含引导代码、声明、占位示例和说明，不包含密钥、用户令牌、授权缓存或生产运行库。

## 验证

```sh
node --check plugin-dev/mcp/examples/feishu-doc/server.cjs
node --test plugin-dev/mcp/examples/feishu-doc/server.test.cjs
```

本机额外验证真实官方运行库的 MCP 握手及工具发现、工作台 MCP 管理器托管和原配置不变。未读取真实文档、未验证模型实际调用或完成新的用户 OAuth 授权。

这是独立 MCP 服务，按 `docs/mcp-service-development.md` 交付，无需 `.plg` 或更新桌面宿主。

上游实现：[larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)。引导代码依赖 0.5.1 的路径配置接口，升级官方库前须重新验证隔离、工具列表和授权流程。
