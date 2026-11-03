# coding Maven 最小实现

场景：用户或 Agent 在已选 Java 项目中执行一次编译并读取结果。主要矛盾是现有只读浏览器不能把代码理解与编译反馈连起来；复用插件独立后台，不改宿主或其他插件。

边界：只执行固定 Maven compile 生命周期，优先项目 mvnw，否则 PATH 中的 mvn。用户选择项目根或包含 pom.xml 的相对子目录。依赖本机 JDK；不安装运行时、不提供任意命令、测试/发布或 Java 跳转实现。Maven 会执行项目构建逻辑、写 target 和本机依赖缓存，并可能联网。

方案：独立 MavenBuild 管理一个异步任务；start 立即返回任务快照，status 返回同一任务日志，cancel 停止其进程组；禁用/关闭停止活动任务。只保留最近一次任务，日志限制 128 KiB，默认最多运行 10 分钟。POSIX 进程行为放 os/posix，由 mac/linux 显式复用；Windows 暂不支持编译。Git 与编译的进程登记合并，防止相互覆盖。

接口：code.compile({path?})、code.build({})、code.cancelBuild({id})。编译/取消能力声明进程副作用，编译要求确认；原有七个只读接口不变。切换目录时如正在编译则提示先停止。UI 增加 Maven 编译面板、模块目录、启动/停止和日志，定时读取后台状态，界面重载可恢复观察。

- [x] 先写真实子进程测试：wrapper 优先、固定参数、成功/非零退出、缺失 pom、目录逃逸、并发、日志上限、进程组停止和插件停止；运行失败。
- [x] 实现 MavenBuild、OS 进程操作、共享进程登记、生命周期和 Agent 能力；领域测试通过。
- [x] 增加编译面板，更新说明与版本，构建 .plg；验证真实编译及工作台启动/停止/能力调用。

Java 跳转方案：下一步可做源码定义候选搜索，返回 path/line/kind 和候选列表，复用当前 read 定位；限制为项目源码，不承诺重载/继承/依赖库语义准确。完整语义跳转再接独立 JDT LS，不引入 IDEA。

验收（2026-10-27，macOS arm64，DeckPg 0.1.28）：

- 20 项领域测试通过，包含 wrapper/模块工作目录、PATH mvn、缺失可执行文件、输出上限、失败退出、取消/超时、正常退出遗留子进程、项目切换并发和停用清理。
- 使用临时下载并校验 SHA-512 的独立 Apache Maven 3.9.16、本机 Corretto 8、现有依赖缓存离线编译真实 Java 项目：成功生成 Main.class；再制造语法错误，确认 failed、exitCode=1 和 COMPILATION ERROR 输出。不依赖 IDEA 的 Maven 发行版，也没有将 Maven/JDK 打入插件。
- 实际 code-browser-0.1.2.plg 隔离安装测试通过：保留 Java/Vue/JS 与 Git 功能、黑白主题、900px 窗口；新增 UI 编译/日志/停止，Agent 网关确认后启动编译并读取状态，页面重载恢复正在运行任务，禁用结束编译且重新启用保留目录。当前插件无独立配置页面，主题通过宿主配置验证；未新增窗口/平铺外壳。
- 首轮集成测试受 macOS Launch Services 清理错误影响；后续重跑全部功能断言与清理通过。Agent 启动调用立即结束，测试必须等待后台任务终态后检查日志，不能将调用成功等同于编译成功。
- 独立审查发现项目切换并发和 wrapper 正常退出后遗留子进程两项问题；均用失败测试复现后修复，并经复审。
- npm run build 与 npm run pack:plugin -- desk/dist/plugins/code-browser 完成；分发包 23661 字节、21 个文件 SHA-256 校验通过；旧版本包保留。未提交 Git。

未覆盖：Linux/Windows 实机、实际模型的工具发现与调用、真实联网依赖下载；Java 跳转仍为方案，未实现。
