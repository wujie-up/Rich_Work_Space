# Coding 工作台编辑与 Spring Boot 运行

> 范围：用户已明确取消 Debug，实施其余六项中与编辑、搜索、目录、运行、历史及分支选择相关的内容。

**Goal:** 在独立 coding 插件内编辑现有源码、切换历史项目并运行 Maven Spring Boot 应用。
**Architecture:** 沿用 Workspace / Maven / 独立进程组与独立视图；所有新增业务代码归 coding，不修改宿主及其他插件。
**Tech Stack:** Node.js、原生 DOM、现有 Maven wrapper、现有轻量 Java 词法器，无新增依赖。

## 场景与主要矛盾

从只读查看推进到最小开发工作台，同时保持低开销并避免丢失源码或遗留服务进程。采用显式编辑与保存、按需扫描和有界日志，复用现有进程所有权机制。

## 实施步骤

- [x] 1. `src/main/common/editor.js`：读取完整 UTF-8 编辑快照，128 KiB 上限，保存校验 SHA-256，保留 BOM、换行和权限；测试外部修改、越界、空文件。
- [x] 2. 扩展 `index.js`：项目历史最多 20 项，复用 settings 持久化；增加编辑与运行 RPC/Agent 能力；运行时阻止 Git 写与项目切换，禁用插件时清理服务进程。
- [x] 3. `spring.js`：按需扫描主源码中的 Spring Boot 类并归属最近 POM；复用 Maven 命令选择，允许不同应用分别启停，保存有界日志；测试假 wrapper 的参数、重复启动、停止及关闭清理。不做 Debug。
- [x] 4. renderer：显式编辑/保存与 Ctrl+S，切换文件/项目/Git 写前确认未保存内容；Java 搜索默认隐藏，Ctrl+F 打开、Esc 收起；历史选中高亮；修复目录缩进并验证单子目录链合并。
- [x] 5. renderer：Git 基准与目标改为树形分支弹窗，按 `/` 分组，与 Agent 的选择方式一致；保留 HEAD/工作区/暂存区及历史提交的比较能力。
- [x] 6. renderer：右侧 Spring Boot 栏，扫描、启动、停止、应用状态与日志；可见且有运行任务时轮询，无后台全量索引。
- [x] 7. 验证插件领域测试、真实 .plg UI 明暗/窄窗口/快捷键/启停/历史与禁用清理；递增版本、根构建与打包交付，不提交或推送开发仓库。

## 验收与重点边界

保存后磁盘内容一致；外部修改不覆盖并保留草稿。未保存切换可取消。Ctrl+F 不常驻。目录层级缩进和折叠合并真实可见。历史重启后恢复且仅选中当前项目。分支选择不需要手填版本。Spring Boot 启停归属独立进程，退出不遗留本次任务；发现不执行项目代码，截断明确提示。真实 Spring 依赖启动与测试替身验证分开报告。

## 执行记录

沿用当前包含已确认功能的开发目录，不创建会丢失未提交源码的另一个 checkout。只进行 coding 领域修改。源码编辑不提供补全、格式化或新建文件；保留原只读分页用于大文件与历史版本。

### 本次验证（0.1.14）

- `node --test plugin-dev/code-browser/test/*.test.js`：47/47 通过，包含磁盘版本冲突、编码/权限保留、项目历史、Git 常用操作、Maven 与 Spring Boot 进程清理。
- `npm run build` 与 `npm run pack:plugin -- desk/dist/plugins/code-browser`：通过，生成 `plugin-dev/dist/code-browser-0.1.14.plg`。
- `node --test plugin-dev/code-browser/test/electron/browser.test.js`：真实安装包 1/1 通过；覆盖编辑保存及冲突保留、快捷键、目录合并与实际缩进、历史项目切换/重载、本地远程分支选择、Git 管理、明暗主题、窄窗口与启停。
- 独立审查指出的远程分支归类、基准选项和项目切换刷新竞态均已修正。
- Spring Boot 使用临时 Maven wrapper 验证启动参数、日志及进程所有权；未运行真实业务项目及依赖下载，不宣称应用已就绪。未实现 Debug，未提交、推送或安装到用户日常工作台。
