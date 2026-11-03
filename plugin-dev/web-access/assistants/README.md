# DeskPG 助手

`Shared/Client` 为 SwiftUI / Network / WebKit 共用实现，`core` 为协议、安全边界和证书日期解析；官方 IrohLib 锁定 1.2.0。设备私钥、配对主机存在本应用 Keychain，邀请密钥不持久化。未开启 VPN，不安装根证书，不修改系统代理。

## macOS

Apple Silicon，macOS 15+，Swift 6+：

```sh
node plugin-dev/web-access/assistants/build/resources.mjs
swift build --package-path plugin-dev/web-access/assistants -c release
node plugin-dev/web-access/assistants/build/package-mac.mjs
```

生成 `plugin-dev/web-access/dist/assistant/Work Desk Assistant.app`，随 `web-access` 的 `.plg` 一起交付，由插件内显示器按钮启动，无需另装 App，不写 `/Applications`。仓库 `npm run build` 自动执行此构建。关闭最后一个窗口即退出，禁用插件或退出工作台也会关闭其助手进程。正式签名使用稳定 bundle ID，升级保留 Keychain 身份；当前包仅临时签名，未公证。

## iOS 27.2

先在仓库根目录运行 `node plugin-dev/web-access/assistants/build/resources.mjs`，生成同一 Web 构建资源，再打开 `ios/DeskLink.xcodeproj`，在 Signing 选择自己的 Team，在 Xcode 选择 iOS 27.2 真机并运行。项目通过本地 Swift Package 引用同一套客户端和锁定的官方 IrohLib；联网解析依赖可能需要访问 GitHub Releases。iOS 使用前台连接和切换应用时最多 20 秒的系统后台任务，不启用后台常驻或 Network Extension；系统可提前结束后台时间。

必须在真机验证：蜂窝与家庭网络、直连/中继切换、短暂切换应用保留页面、后台超时释放和返回前台重连、证书拒绝、设备撤销，以及插件 frame 的来源隔离。模拟器不能代替 NAT 穿透验收。

资源构建同时将工作台原图 `desk/src/resource/icons/app.png` 缩放为 iOS AppIcon，生成目录为 `web-access/dist/ios/Assets.xcassets`。首次使用显示绑定表单；已有配对时，首页显示“已绑定”和圆形连接按钮，齿轮入口可重新绑定。升级沿用原 bundle ID 与 Keychain。

## 验证

```sh
swift test --package-path plugin-dev/web-access/assistants/core
swift run --package-path plugin-dev/web-access/assistants/core CoreCheck
node --test plugin-dev/web-access/test/swift-peer.test.mjs
```

仅安装 Command Line Tools 的机器可能没有 XCTest；`CoreCheck` 为不依赖 XCTest 的同等关键协议断言。macOS 构建不能证明 iOS SDK 或真机兼容。具体执行结果见仓库的本次验收说明。

`swift-peer.test.mjs` 使用临时身份和账号，不读取助手 Keychain；编译生产客户端并验证真实 QUIC、TLS、WebKit 固定证书与登录。已通过错误固定证书拒绝、真实登录及独立来源插件 iframe；Web 证书已补 serverAuth EKU 并兼容更新旧证书，保留 Apple SSL 主机名和有效期校验。

外壳构建产物生成在 `Shared/Client/Resources/WebShell/`，不作为源码维护。SwiftPM 将其打入独立资源 bundle；版本不匹配或资源缺失时使用远程页面。按工作台身份隔离 HTTP 缓存，连接前清除其他 WebKit 数据，撤销网页登录时清除全部缓存；不持久化账号密码或业务快照。
