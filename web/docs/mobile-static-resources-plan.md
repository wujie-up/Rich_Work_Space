# 手机静态资源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. 用户已批准设计并要求实施；当前会话执行，不提交代码。

**Goal:** 减少手机连接后的外壳传输、插件重复下载和首页串行往返，保持 Web 安全边界。

**Architecture:** 同一 Web 构建生成内容版本，助手内置该构建并只在服务器匹配版本时注入。插件使用完整性摘要 URL 和私有静态缓存；每工作台独立 WebKit 缓存及稳定 loopback 端口。初始化并行预取仅存在当前认证会话内。

**Tech Stack:** Node.js、esbuild、HTTPS、SwiftPM、WebKit、Network.framework、现有 iroh。

**Spec:** web/docs/mobile-static-resources-design.md（2026-10-31 用户批准）

## Global Constraints

- 仅 web/、plugin-dev/web-access/ 及其直接测试；desk 和插件正文不修改。
- 原认证、来源、证书钉扎、固定服务和生命周期约束保持；动态业务响应 no-store。
- 不添加依赖；资源由构建生成；macOS 15+、iOS 27.2；失败回落原网络加载。
- 无 git add/commit/push；沿用当前包含已授权前序改动的 checkout，不搬走或覆盖无关改动。
- 构建新版本 .plg 和 iOS 助手；宿主安装重启另行确认。

## Review Focus

1. 服务器和助手构建不同、资源损坏或注入失败：只回落远程一次，不能白屏或反复重载。
2. 插件包版本号未变但内容变化：摘要变化；错误摘要、路径穿越、符号链接不能命中缓存。
3. 账号撤销或停用期间异步读取：仍拒绝返回，错误和动态内容不缓存。
4. 初始化预取与 SSE 变更竞争：过期快照不得覆盖变更后的列表；失败不伪装成功。
5. 稳定端口被占用、重连或换工作台：安全回落随机端口，缓存隔离且不保留业务会话。

### Task 1: Web 资源版本和静态服务

**Files:** web/build/build.mjs；新增 web/src/server/static-resources.js；http.js、workspace.js、transport.js；新增 web/test/static-resources.test.js，扩展 server/transport 测试。

**Interfaces:** 构建生成 shell-manifest.json（version 及 app.js/app.css SHA-256）；`shellDocument(directory, version)` 返回匹配的无脚本样式文档或 null；`pluginResources(directory)` 提供按 integrity.json 摘要的 `entry` 和 `resolve(path)`。`staticFile` 支持响应前授权复核与私有静态缓存参数。

- [x] 先写测试：匹配/不匹配外壳；摘要前缀的包内容及旧包回退；JSON/API/错误 no-store；恶意路径和撤销竞争。
- [x] 运行 `node --test web/test/static-resources.test.js`，确认缺失功能失败。
- [x] 生成 manifest；仅匹配版本协商无脚本样式主文档；映射所有声明视图入口及资源路径；授权复核在读取/压缩后、写响应前执行。
- [x] 运行新增测试和 Web server、transport、races 测试，预期全部通过。

### Task 2: 首页并行初始化

**Files:** web/src/browser/adapter.js；新增 web/test/startup.test.js。

**Interfaces:** browserApi 现有返回接口不变；初始 storage.getPreferences/plugins.list/desktop.list 同时发起，仅首次消费结果。变更事件使相关未消费快照失效。

- [x] 先写可控 fetch/SSE 测试，断言三个请求在任一完成前均发出、初次 onopen 不重复请求、重连刷新、事件竞争及失败行为。
- [x] 运行 `node --test web/test/startup.test.js`，预期失败。
- [x] 实现会话内预取和事件失效，保存原请求错误语义，撤销停止预取结果交付。
- [x] 运行 startup 与浏览器集成测试；比较 1000ms/RPC 夹具的初始化和调用次数。

### Task 3: 助手资源、缓存和端口

**Files:** web-access/assistants/Shared/Client/{Browser,ClientModel,Loopback}.swift；新增 StaticResources.swift；Package.swift；assistants/build 资源准备及 mac 打包；直接相关 assistant/Swift peer 测试。

**Interfaces:** BrowserContext 增加可选 hostId，保留现有测试构造兼容；新资源类负责验证 manifest、生成限定 origin 的 WKUserScript、独立数据存储与清理；Loopback 新增可选 hostId 以派生首选端口，启动失败时仅端口占用回落随机。

- [x] 先扩展真实 WebKit/Swift 检查：内置不请求 app.js/css、失配网络回退、注入失败单次回退、HTTP 缓存重连、Cookie 等非缓存数据清理、端口占用。
- [x] 运行检查，确认缺失功能失败。
- [x] 添加生成资源及 SwiftPM 资源声明，复制 Mac bundle；构建资源 SHA-256 校验、原 origin 注入、有限回退；连接前等待存储清理；稳定端口及日志；撤销清理缓存。
- [x] 运行 Swift 构建、核心/助手测试、真实 WebKit 与 QUIC 固定服务检查，预期通过。

### Task 4: 交付与验收

**Files:** 插件 manifest/package/lock/README、iOS 必要版本配置、文档验证记录。

**Interfaces:** 版本 0.1.12，旧包保留；宿主仍使用当前版本号，不擅自改 desk/根包版本。

- [x] 记录受影响领域测试、加载测量和安全回归；由独立 reviewer 检查本次完整改动，修复重要问题并运行针对性测试。
- [x] 运行 `npm run build --prefix plugin-dev/web-access` 和 `npm run pack:plugin -- plugin-dev/dist/.staging-web-access`；构建宿主更新包与已授权个人签名 iOS 包，校验签名和 .plg 完整性。
- [ ] 安装手机助手（保留配对）；若锁屏请求必要人工操作。宿主替换前确认重启时机，再做真实蜂窝验证；本地测试不冒充实机。

## Progress

- Pre-flight: Task 1 manifest → Task 3 resource bundle：同一 Web 构建输出，不复制第二套源码。
- Pre-flight: Task 1 versioned view.entry → Task 2 plugins.list：接口保留 origin，entry 独立前缀。
- Pre-flight: Task 3 fixed loopback → Task 1 transport：仅已声明 service origins，服务授权契约不变。

- 2026-10-31 实施：Task 1–3 已实现。新增静态/启动/Swift 用例先观察缺失功能失败，再运行通过；账号、服务器、竞争、传输与静态/启动 17/17，插件权限/助手/协议/配对/归档 15/15，Swift 资源与端口 3/3，真实 Swift QUIC + WebKit 1/1，Chromium + WebKit 浏览器集成 1/1。
- 独立 reviewer 完整只读审查发现一个 Important：初次 SSE 建立前的插件变化可丢失。已将插件快照延后至订阅建立，其他读取保持并行；新增用例先失败后通过，startup 5/5。没有未处理的审查缺陷。
- 最终同一 1000ms/RPC WebKit 夹具：1397ms（基线 3349ms）；偏好/桌面/插件分别 163/164/210ms 发出，首次无重复插件读取。这是本地延迟夹具，非蜂窝测量。
- 实际 WebKit 证明匹配构建的远程 app.js/css 请求为 0；重新建页并清 Cookie/重新登录后，插件 HTML/CSS 累计各请求 1 次；失配和坏脚本单次回落均可显示登录页，错误证书仍拒绝。
- 插件 0.1.12 已构建并从显式 staging 清单打包为 plugin-dev/dist/web-access-0.1.12.plg，旧包保留；包测试校验可执行权限、签名、外壳资源完整性及开发/用户数据排除。宿主已构建打包，等待最终签名检查及用户重启时间确认。
- iOS 增量构建的资源复制未触发主 App 重签，发现资源封印失效；clean build 后已通过 codesign --verify --deep --strict，并覆盖安装成功，保留配对。Web、Mac 和 iOS 三份内置清单摘要完全相同。宿主包也已通过深度严格签名校验。
- 2026-10-31 19:33 再次检查 Clash 运行时规则：仅四类 OpenAI 域名经 AI 组，MATCH DIRECT；当前中继 TCP 和 UDP 两条连接均为 [DIRECT]，非 OpenAI 代理连接为 0，TUN 仍开启。
- 用户确认重启后，已正常退出并安装、重启 /Applications/DeckPg.app，严格深度签名校验通过；运行时插件清单确认为 0.1.12，远程服务已恢复，原手机配对仍在。iOS 0.1.12 已启动日志，实机显示 cellular=true、wifi=false，并建立加密中继连接；页面与重复打开速度仍待用户反馈，尚未完成蜂窝验收。
- 更新后 19:32 的 Clash 运行时快照再次显示中继 TCP/UDP 均为 [DIRECT]，非 OpenAI 代理连接为 0；证据位于 /tmp/work-desk-clash-openai-only-post-update-20261031.json。DIRECT 仍经过已开启的 TUN，不代表绕过 TUN。
- 蜂窝首轮用户反馈：首页约 4 秒出现；插件首次打开仍慢，第二次打开加快；Agent 等部分插件无法加载完成。因此只确认首页可用及重复打开改善，整体插件验收仍未通过。
- 排查：实机中继 RTT 约 695–1234ms，Agent 首轮插件流已下载至 180752 字节；未记录到对应导航失败。使用已安装的同一份 Agent 静态资源、独立临时 HTTPS 服务及模拟空会话 RPC，在 WebKit 中执行全部初始化调用可显示工作区，脚本错误和资源请求失败均为 0。该夹具不使用真实账号、历史或引擎，也不能代替实机业务验证；尚不能确定加载不完整的原因，未改动 Agent 插件正文。
- 用户补充症状：插件从白屏显示背景后无数据，久等后提示 Load failed。既有导航日志无法定位对应 fetch；新增手机主 frame RPC 元数据追踪，区分请求、响应头、JSON 正文完成/失败，最多 512 条；仅记录方法、插件 ID、耗时与阶段，不记录参数、错误消息、账号或响应内容，原请求/响应和异常保持不变。
- 0.1.13 仅在助手中增加诊断：4 个 JS 行为用例、4 个 Swift 资源/隔离用例、实际 WebKit HTTPS fetch/json 及插件包检查均通过。已 clean build、严格校验 iOS 签名并覆盖安装、启动日志，配对保留。生成 plugin-dev/dist/web-access-0.1.13.plg，未更新正在运行的电脑插件（仍为 0.1.12；协议与后台逻辑未变），无需重启宿主；等待单独打开 Agent 的实机失败追踪，尚未确认根因或修复。
- 0.1.13 实机复现记录：偏好读取耗时 21422ms 后，Agent 的 sessions.setTheme 复用同一工作台 TLS 流，2114ms 后发生 fetch-failed/TypeError；storage.savePreferences 也有同类失败。adapters.list 换连接后成功但耗时 13548ms。后续 conversation.registerWindow 期间助手进入后台并断开，因此没有取得完整初始化结果。日志只包含 RPC 方法、插件、阶段和耗时，不含参数及响应正文。
- 隔离 WebKit 对照：TCP 转发将服务端响应延迟 7500ms；Node 默认 keepAliveTimeout=5000ms、buffer=1000ms 时，第一个 POST 成功，紧接着的 POST 在 6002ms 后报 Load failed。仅将空闲超时改为 60000ms 或 0，三次 POST 均成功。当前修复后的真实 Web listener(null) 对照也三次成功，分别为 7506/7509/7506ms；证据 /tmp/wd-keepalive-probe-default2.log、/tmp/wd-keepalive-production-20261031.log。
- 有界修复仅涉及 web/src/server/http.js、web/test/http.test.js：不绑定公网/局域网端口的远程接收器关闭 HTTP 空闲计时，由已有传输授权负责关闭连接，避免响应还在中继链路中时过早关闭；LAN 仍保留默认 5 秒空闲限制。每授权 32 条连接、授权撤销/账号撤销、HTTPS、来源校验及固定服务范围保持原契约，没有增加写请求重试。代价是空闲远程连接可占用既有连接配额直到客户端或授权关闭。
- 新回归用例修改前因远程 socket 在 6.5 秒内已关闭而失败；修改后连接可复用且关闭接收器立即断开。HTTP、server、transport、races 共 9/9 通过，另真实延迟 WebKit 1/1 通过。宿主 build:desk、arm64 应用打包及 codesign --verify --deep --strict 均通过，包内 HTTP 源码与已验证源码逐字相同；手机外壳摘要未变化，无需重装手机。更新应用位于 desk/dist/releases.noindex/mac-arm64/DeckPg.app，尚未安装/重启，等待用户确认时机；实机蜂窝 Agent 验收仍未通过，不能据此宣称所有加载延迟已解决。
