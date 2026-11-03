# DeskPG 网页工作空间

网页端复用桌面界面、插件后台与数据，浏览器独立管理自己的标签。默认关闭，DeskPG 退出后不可访问。

## 使用

1. 在桌面端「设置 → 桌面」点击「网页端」旁的设置按钮。
2. 创建账号（密码至少 8 个字符），按需修改端口（默认 47831），再开启网页端开关。
3. 使用设置中显示的 HTTPS 本机或局域网地址访问。首次访问需手动信任本机生成的证书；证书路径也显示在设置中。插件独立端口复用同一证书。
4. 登录后共用桌面的配置、插件、桌面文件和历史。文件选择使用浏览器上传；桌面文件可下载。系统文件夹选择、系统剪贴板、退出应用等原生操作仅在桌面可用。

账号由桌面端管理，保存在现有数据目录的 `web/accounts.sqlite`。重置密码或删除账号立即撤销该账号会话。关闭网页开关断开全部网页连接；再次开启须重新登录。账号具有同等共享工作空间权限，包括已启用可信插件的既有能力，不按账号隔离数据。

服务监听本机及局域网 IPv4 地址，插件视图使用额外动态 HTTPS 端口。浏览器与防火墙需允许这些连接。未配置公网入口、自动路由器映射或系统证书信任。

## 目录

- `src/server/`：HTTPS、账号、会话、受控 RPC、事件及文件传输。
- `src/browser/`：登录、浏览器 API 适配、桌面管理入口。
- `build/`：复用桌面 renderer 构建；`dist/` 为生成物。
- `test/`：使用临时数据的认证、生命周期、桥接及 Electron/Chromium 集成验证。

构建：`npm run build:desk`（完整插件构建使用 `npm run build`）。

相关验证：

```sh
node --test web/test/accounts.test.js web/test/native.test.js web/test/plugin-host.test.js web/test/server.test.js web/test/races.test.js
node --test web/test/browser.test.js
```

集成验证覆盖真实 Electron 设置入口、两个 Chromium 客户端登录、上传下载、独立来源文本插件、客户端关闭保留后台及开关关闭撤销。Chromium 测试使用临时证书并忽略证书信任错误；不替代真实局域网设备的证书信任与防火墙验收。未改动已安装应用和真实数据。

## 本次插件包

通信桥兼容包位于 `plugin-dev/dist/`：

| 插件 | 版本 |
| --- | --- |
| ai-agent-sessions | 0.6.78 |
| code-browser | 0.1.35 |
| codex-capture | 0.2.14 |
| mcp-services | 0.4.30 |
| pingcode | 0.4.1 |
| resource-monitor | 0.1.16 |
| text-editor | 0.1.44 |
| work-flow | 0.5.48 |

文件名为 `<插件 ID>-<版本>.plg`。仅生成包，未替换当前已安装版本。
