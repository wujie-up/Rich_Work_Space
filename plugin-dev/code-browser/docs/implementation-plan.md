# 独立代码浏览插件

场景：Agent 与用户在工作台内只读理解本地项目及提交差异。主要矛盾是源码与 Git 上下文获取依赖 IDE；因此复用宿主隔离、视图和能力协议，仅新增 code-browser 领域。

目标：不安装 IDEA/JDK 即可浏览 Java、Vue、JS 等 UTF-8 文件、文本搜索、查看提交历史、历史文件和 Git 差异。Git 功能依赖本机 Git；普通目录仍可查看源码。

架构：独立 Node 后台负责目录边界、文件读取和受限 Git 子进程；沙箱视图通过通用桥调用；Agent 通过 desk.capabilities.v1 调用同一实现。项目目录由用户选择并持久保存，Agent 不能切换目录。只读，不提供编辑、提交、运行或调试。

约束：不修改宿主和其他插件、不提交 Git；新插件 0.1.0、单实例、服务后台、黑白 SVG、主题跟随宿主；构建并交付标准 .plg。

任务与验证：
- [x] 先写并运行失败测试：目录逃逸、UTF-8、搜索边界、真实 Git 提交/工作区/暂存区/子目录、取消和能力注册。
- [x] 实现文件、Git、后台能力及最小浏览界面；运行领域测试至通过。
- [x] npm run build；npm run pack:plugin -- desk/dist/plugins/code-browser；真实安装包在隔离桌面内验证浏览、Git、主题、能力调用和停用。
- [x] 独立只读审查，修复阻断问题并重新构建；撤回本次误建的 IDEA 产物。

接口：UI 方法 code.workspace/code.select/code.list/code.read/code.search/code.log/code.diff/code.show。Agent 能力对应 workspace/list/read/search/log/diff/show，输入为单个对象，路径相对已选目录；版本 HEAD/分支/提交，diff 目标额外支持 WORKTREE 和 INDEX。

Review focus：路径/符号链接边界、Git 参数注入与路径字面量、输出/耗时上限、取消与停用、源码不执行、子目录 Git 范围、能力输出不超过宿主上限。

Pre-flight：文件模块向后台与 Git 提供同一 canonical root 和相对路径校验；UI 与能力共用 handler，避免两套校验。Git 工作区不包含未跟踪文件，界面与文档明确此范围。

审查记录：独立 reviewer 发现签名验证/工作区过滤器执行外部程序、长目录输出超过宿主 1 MiB、FIFO 阻塞读取三项问题，均以失败回归复现后修复。11 项领域测试通过；Git 子进程取消和输出限制另有真实子进程验证。未引入目录并发恶意替换的文件系统沙箱；本插件用于用户选定的可信本地项目，未验证恶意并发目录替换。

集成修正：真实工作台沙箱未开放 allow-forms，导致表单 submit 不触发。改为按钮及键盘事件经宿主 RPC 调用，不调整宿主权限。

验收：2026-10-27，macOS arm64、Node 22.23.1、DeckPg 0.1.27。11 项领域测试和 1 项隔离工作台端到端测试通过；安装实际 .plg，验证 Java/Vue/JS、源码不执行、搜索、提交对比、历史文件、配置中的主题切换、重新打开目录持久化、禁用撤销及重新启用。7 项能力可发现，公共能力契约调用 code.read/code.diff 成功；没有验证真实模型发现和调用，也没有宣称 Linux/Windows 或调试支持。

交付：plugin-dev/dist/code-browser-0.1.0.plg，17866 字节，15 个文件均通过 SHA-256 完整性校验。仅新增 code-browser 领域，无宿主/其他插件源码变更，无 Git 提交。
