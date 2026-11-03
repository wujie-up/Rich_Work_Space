# coding 0.1.20

Work Desk 独立插件，不依赖 IDEA。浏览使用工作台自带 Node 运行时，Git 功能需要本机 Git；Maven 编译需要本机 JDK，以及项目 mvnw 或 PATH 中的 mvn。

## 使用

在工作台插件管理中导入 `code-browser-0.1.20.plg`，启用后打开“coding”，点击“打开目录”选择项目。

- 目录可直接展开/收起，保留父级与兄弟文件；“刷新”重新读取目录树。文件名按 Java、前端脚本、样式与标记文件区分颜色；JSON、Java、Vue、脚本/标记、样式、Markdown 和 .gitignore 使用简洁 SVG 类型图标，其余使用通用文件图标。图标仅按文件名选择，不额外读取文件或加载图标库。
- 点击文件查看带行号及轻量词法高亮的源码，每页 500 行；支持 Java、Vue、JS、TS 及其他 UTF-8 文本。
- 代码区默认显示，右上角 Git / Maven 切换工具视图，再次点击当前入口返回代码区；选择文件也会返回代码区。
- 当前 Java 文件双击标识符，或用 Ctrl+F（macOS 也支持 Cmd+F）调出搜索后输入类/方法名称点击“查找定义”，从同名候选中点击跳转到文件行。只扫描项目 Java 源码，不解析继承、重载、依赖库；历史版本不跳转。
- 搜索为区分大小写的字面文本搜索，结果点击跳转；跳过 `.git`、`node_modules`、`target`、`dist` 等生成目录及符号链接。
- “Git 对比”的基准和目标使用本地/远程分支树选择，另保留 HEAD、工作区和暂存区。目标 `WORKTREE` 包含相对于基准的已暂存和未暂存修改，`INDEX` 只比较暂存区。未跟踪文件不在 Git 差异中。
- “提交历史”列出最近 30 条，点击提交设置基准；点击另一侧分支选择可调整目标。勾选“仅当前文件”限定范围。
- 选择文件后，将目标设为实际提交/分支/标签，点击“读取目标版本文件”查看历史源码。

- “Maven 编译”输入包含 pom.xml 的相对模块目录（留空为项目根），点击“编译”。优先模块 mvnw，再用项目根 mvnw，否则执行 PATH 中的 mvn。基础参数为 `--batch-mode --no-transfer-progress -Dstyle.color=never`，可选择生命周期阶段及构建选项，默认执行 compile，不提供任意自定义命令。
- 编译会执行项目构建逻辑、写入编译产物/依赖缓存并可能联网。可查看输出和停止任务；同一时间只运行一个，10 分钟超时，日志保留最后 128 KiB。页面重载会恢复观察，后台重启后不保留任务日志。

项目目录按插件 ID 保存。关闭或禁用会中止查询、Git 与 Maven 进程，保留已经写入的编译文件。普通非 Git 目录也能浏览、搜索。编译目前提供 macOS/Linux 的 POSIX 实现，本次仅验证 macOS；Windows 编译暂不支持。

## Agent

通过宿主 `desk.capabilities.v1` 发现 `pluginId: "code-browser"`。浏览及 Git 查询只读；Git 管理声明文件、进程与网络副作用，始终要求确认；编译和停止任务声明进程副作用，编译始终要求确认。用户须先在界面选定目录，Agent 不能切换目录。原生 Agent 是否发现这些工具，取决于所用 AI 插件的通用能力桥接配置。

| 能力 ID | 输入示例 |
| --- | --- |
| `code.workspace` | `{}` |
| `code.list` | `{"path":"src"}` |
| `code.read` | `{"path":"src/Main.java","startLine":1,"endLine":80}` |
| `code.search` | `{"query":"createOrder","path":"src","limit":30}` |
| `code.definitions` | `{"name":"createOrder"}`；返回 `{candidates:[{name,kind,path,line,text}],scanned,truncated,reason?}` |
| `code.log` | `{"revision":"HEAD","path":"src/Main.java","limit":20}` |
| `code.diff` | `{"base":"HEAD~1","target":"HEAD","path":"src/Main.java"}` |
| `code.show` | `{"revision":"HEAD~1","path":"src/Main.java","startLine":1}` |

| `code.mavenProjects` | `{}`；返回 Maven 项目（path、name、parentPath）及截断标记；parentPath 为声明它的聚合 POM 目录，null 表示独立根项目 |
| `code.compile` | `{"path":"module","phase":"package","clean":true,"skipTests":true,"alsoMake":true}`；立即返回 `{task}`，构建继续在后台运行 |
| `code.build` | `{}`；返回最近任务 `{task}`，无任务时为 null |
| `code.cancelBuild` | `{"id":"编译任务ID"}` |

Agent 启动编译后用 `code.build` 读取 state、exitCode、log、truncated、error；终态为 succeeded/failed/cancelled。停止编译调用 code.cancelBuild；取消已经结束的启动调用不会停止后台编译。

路径相对已选目录；打开 Git 子目录时，历史和差异也限定在该目录。读取文件最多 1 MiB，单次返回最多 500 行/128 KiB；Git 差异最多 128 KiB、单条 Git 命令最多 10 秒；搜索最多 100 条匹配、10000 个条目或 10 秒，达到限制返回 `truncated` 和原因。遇到大文件/大差异请缩小行范围、文件或子目录。

支持现有 UTF-8 文本编辑与 Maven Spring Boot 启停，不提供 Debug、补全或格式化。Java 定义为轻量声明候选，不接 JDT LS；每次从磁盘扫描，最多 100 个候选、10000 项或 10 秒。词法高亮不做语义分析，跨页多行字符串/注释可能缺少上一页上下文。

## 开发

在仓库根目录运行：

```sh
node --test plugin-dev/code-browser/test/*.test.js
npm run build
npm run pack:plugin -- desk/dist/plugins/code-browser
node --test plugin-dev/code-browser/test/electron/browser.test.js
```

打包使用构建暂存目录，只分发运行资源；输出为 `plugin-dev/dist/code-browser-0.1.20.plg`，包含 SHA-256 完整性清单。

目录中的单子目录链自动合并显示（最多向下预读 16 层，每次列表最多预读 256 个目录），不扫描整个项目。Git 对比可选择两个本地或远程分支，提交历史可设置基准版本；按文件显示新增、删除、修改，展开查看带双侧行号的统一差异。多文件默认折叠并按需创建差异行；输出仍限 128 KiB，不含未跟踪文件。

Maven 支持按需发现 pom.xml 并选择项目/模块，以及 default、clean、site 三套生命周期的全部阶段（默认 compile）。项目树只显示 POM 项目，名称优先取自身 artifactId，按 project/modules/module 声明嵌套，不显示普通目录或重复路径行；路径保留在悬停提示中。没有被模块声明引用的 POM 作为独立根项目显示。发现过程只读取文件，不执行 Maven。支持先 clean、跳过测试、从根 POM 以 -pl/-am 构建模块及依赖；未配置为根聚合项目的模块需自行选择合适目录。deploy/site-deploy 会二次确认发布影响。Agent 可使用 code.mavenProjects 发现项目，code.compile 可指定 phase、clean、skipTests、alsoMake；不支持任意插件 goal 或任意命令参数。项目发现限 200 个项目/10000 项/10 秒，刷新手动触发；不解析 profile、POM 属性、依赖与仓库模型。

## Git 管理（0.1.20）

Git 标签内提供本地/远程分支树、当前分支、暂存/工作区文件及冲突状态。可切换、新建、重命名、安全删除分支，fetch、pull（默认 ff-only，可选择 merge/rebase）、push 并设置跟踪，暂存/取消暂存、提交、merge、rebase、cherry-pick、revert、储藏保存/应用/弹出/删除、soft/mixed/hard reset 和丢弃指定已跟踪文件修改。操作前展示实际仓库根目录、参数和影响并确认。冲突可在插件编辑后暂存，再继续或中止；取消进程不自动撤销已完成的修改。

打开子目录时，Git 管理作用于实际 Git 仓库根目录，文件选择以仓库根目录为基准。任务在后台执行，支持日志、停止、10 分钟超时及页面重载恢复观察。Git、Maven 和项目切换互斥；Git 仓库资源锁持续至进程及子进程退出，与 Agent 共用宿主互斥机制，需配套最新工作台。远程操作使用本机 Git 的既有配置，不提供认证设置。

Agent 同样调用 `code.gitStatus`、`code.gitOperation`、`code.gitTask`、`code.cancelGit`，例如 `{ "action": "createBranch", "newBranch": "feature/demo" }`；启动立即返回 task，随后轮询 gitTask。终态 succeeded/failed/cancelled/conflicted。危险操作 hard reset、discard、stashDrop 还需 confirmed:true。文件暂存示例 `{ "action":"stage", "paths":["src/Main.java"] }`；pull/push/fetch 必须指定已配置的 remote。

不支持强推、强制删除分支、清理未跟踪文件、交互式 rebase、子模块或 Git LFS 专项管理。不会向当前开发仓库自动提交或推送。

## 编辑与运行（0.1.20）

文件工具栏的编辑图标切换到轻量文本编辑器，Ctrl+S / Cmd+S 保存，支持 Tab 插入缩进。单文件编辑上限 128 KiB；保留原 UTF-8 BOM、换行格式和权限，保存时检查磁盘版本，外部修改后拒绝覆盖并保留草稿。切换文件、项目或执行 Git 写操作前可取消丢弃未保存内容。历史版本仍只读。Java 定义搜索默认隐藏，Ctrl+F 打开、Esc 收起。

左侧保留最近 20 个项目，点击切换并高亮当前项目。单子目录链折叠为组合路径，展开后的子项保留缩进。

右上角 Git、Maven、启动项按钮控制同一个右侧面板，默认收起；再次点击当前按钮收起，切换工具保留任务和输入。源码始终保留在中间；窄窗口右侧面板覆盖部分编辑区。

右侧 Spring Boot 栏按需发现 Maven 模块内带 SpringBootApplication / SpringBootConfiguration 和 main 方法的类，归属最近的 pom.xml，跳过测试及生成目录。轻量声明扫描，不解析 Maven profile、继承和自定义组合注解。支持最多 8 个应用分别启动、停止及日志查看，使用模块 Maven wrapper、根 wrapper 或本机 mvn 执行 spring-boot:run。项目需已配置 Spring Boot Maven 插件及模块依赖；不自动安装聚合模块依赖。启动表示进程运行，服务是否就绪以应用日志为准。

日志每任务最多 128 KiB，仅有运行任务且页面可见时轮询状态，不重复扫描源码。服务运行时禁止 Git 写、Maven 编译和切换项目，先停止服务再操作；禁用插件清理本次启动的进程组。页面重载可恢复运行观察，后台重启不恢复服务。未实现调试。

Agent 新增 code.edit（path）、code.save（path/text/revision）、code.springApps、code.startSpring（启动类 path）、code.springTask（id）、code.stopSpring（id）。保存和启动始终要求确认；读取编辑快照和应用发现只读。


## 分支菜单（0.1.20）

Git 页面提供当前分支入口及新建、推送、更新的图标按钮。点击分支入口搜索并选择最近、本地或远程分支，功能菜单在列表右侧通过悬停或点击联动展开；父级列表可直接切换选中分支。弹出层使用原生 Popover，无背景遮罩或模糊，点击外部自动关闭。空间不足时翻向左侧并限制在窗口内，所有插件弹窗均贴近触发控件侧开。比较默认以所选分支为基准、当前 HEAD 为目标；也可查看工作树差异。支持签出、新建、合并、变基、更新、推送、重命名和安全删除。

更新与推送针对所选本地分支及其跟踪分支。非当前分支通过无 force 的 fetch 快进更新，拒绝分叉和其他 worktree 正在使用的分支，不切换当前工作区。远程分支先签出为本地分支再更新或推送。未配置跟踪时使用第一个远程的同名分支，执行前显示完整参数。

提交、储藏、回滚、任务停止及任意两个版本的对比放入同一入口的“其他 Git 操作”弹窗。最近分支复用最多 40 条 Git reflog，最多展示 10 个仍存在的分支；搜索只过滤已加载列表，不增加后台轮询。支持明暗主题、窄窗口、上下方向键和 Escape 返回上一级。
