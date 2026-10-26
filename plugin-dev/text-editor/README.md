# 文本编辑器 0.1.0

在 Work Desk / RWork Space 的配置 → 插件 → 导入本地插件中选择 text-editor-0.1.0.plg，启用后点击图标打开。此包不需要升级或重新安装桌面。

- 打开文件夹，点击左侧文件；新建文件在顶部填写相对文件名，再保存。改名后点“另存为”。不覆盖已存在的另存目标。
- 支持 UTF-8 TXT、XML、JSON/JSONC、Markdown、YAML 及其他纯文本；单文件最大 256 KiB，保留已有 BOM 和 CRLF/LF。暂不支持其他编码、超大文件及二进制。
- JSON/XML/YAML 点击“格式化”，确认后保存；格式化失败保留原文。JSON/YAML 格式化保持大整数原始精度，YAML 浮点数也保留原始数字文本。
- Markdown 支持编辑、阅读、左右分栏；PlantUML 文件支持直接预览。Markdown 代码块语言使用 mermaid、plantuml 或 puml。
- 所有绘图引擎随包，不需要 Java、Python、Graphviz 安装或联网。PlantUML 使用官方 @plantuml/core 1.2026.9 JavaScript/TeaVM 版本；不保证 Java 版所有功能。外部 include、标准库 include、网络图像和链接跳转不提供，内置主题可用。Mermaid 使用 strict 模式。
- 单个图代码限 20,000 字符；PlantUML SVG 限 4096 像素。复杂图形可能耗时，优先使用小图。
- 未保存文本自动写入插件独立草稿，点击“草稿”恢复为副本；新建或打开其他文件前也会保存草稿。删除草稿不可撤销。多个窗口分别维护草稿和工作目录。
- 保存检测外部修改，发生冲突时保留草稿，需重新打开文件或另存为。当前文件未保存内容不会因格式化失败被清空。
- 跟随桌面当前主题；⌘S / Ctrl+S 保存，Shift+⌘S 另存为，Tab 插入两个空格，支持编辑器原生撤销。

## 开发与打包

在此目录运行 `npm ci --ignore-scripts`，仓库根运行 `node plugin-dev/text-editor/build/build.mjs`。
产物为 `plugin-dev/dist/text-editor-0.1.0.plg`，gzip tar，包含浏览器资源、独立后端和第三方许可证，不包含 node_modules 或开发工具。
插件协议与扩展规范见仓库 `docs/plugin-development.md`。安装不修改其他插件数据；本插件草稿存于宿主 `plugin-data/text-editor/`。
