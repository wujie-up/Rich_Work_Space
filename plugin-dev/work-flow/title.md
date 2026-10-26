# 工作流编排（work-flow 0.3.1）

## 菜单初始化模板

左侧点击“菜单初始化模板”，保存后运行。流程每一步都等待手动确认：

1. 输入 FAT authtoken、roleId，加载真实目录及完整 appCode 分页；token 仅保留在当前插件内存。
2. 输入“在某菜单下加入某菜单，在某菜单下加入某按钮”，选择工作目录并调用只读 Agent。新增项会叠加在目录树，支持修改名称、编码、父节点、路径和排序；有歧义时先澄清。菜单 appCode 在本地生成，编辑时保持稳定。
3. 逐项填写允许修改的相对文件路径及原因，再调用代码 Agent；显示原生审批、问题、实际文件前后内容和验证说明。审查后勾选确认，也可以明确跳过。修改越界或审查后文件变化会阻断确认，不自动回滚工作目录。
4. 核对完整 SQL，确认时重新检查来源目录和编码冲突，再保存完整 SQL 到所选目录。SQL 不会自动执行；执行后展开“手动同步机构”，重新加载来源根菜单并确认目标机构后同步。

返回上游、编辑草稿或重新加载目录会使下游确认失效并停止旧任务。插件重启不恢复执行、不重放同步；可重新运行模板，已生成 SQL 仍可查看。菜单会话和完整 SQL 位于 `plugin-data/work-flow/menu/<runId>.json`。

菜单 Agent 使用 `desk.capabilities.v1`：`agent.menu.plan.start.v1`、`agent.menu.code.start.v1` 与 `agent.task.read/respond/cancel.v1`，需要启用 ai-agent-sessions 0.5.1。任务使用插件受管引擎和隔离账户，不读取系统 CLI 账户。通用 Agent 节点也通过工作台调用 `agent.task.start.v1`，不再依赖旧服务契约。

在桌面上编排 AI 场景的工作流：抓取报错邮件 → 提取关键日志 → 调用 Agent 会话排查 → 汇总结论。
通过节点画布与数据依赖执行，将通用基础能力组合为具体业务场景。

## 属性

application / showIcon true / loadOnStartup false / background service。首次调用 RPC 时激活后台。

## 界面操作

- 左侧：工作流列表；新建、删除。
- 中间工具栏：先选功能分类，再选基础能力，点击加号添加。新节点自动选中，在右侧自定义名称和参数。拖拽标题移动节点；点击节点右侧圆点开始连线，再点击目标节点左侧圆点完成。
  点击连线可选中并删除；连线成环会被拒绝。
- 右侧：选中节点的参数表单（可用变量按钮会把 `{{节点.字段}}` 插入光标处）、运行结果、最近运行、邮件账号管理。
- 顶部：保存、运行、停止。运行中每个节点的状态和输出实时刷新。

## 基础数据与 Agent 能力

| 类型 | 作用 | 主要参数 |
|---|---|---|
| 文本输入 | 流程起点的静态文本或 JSON | content、format |
| 邮件读取 | IMAP 直连收件箱，按时间和关键字过滤正文 | 邮件账号、文件夹、最近天数、关键字、最多返回 / 抓取 |
| 文本提取 | 抽取匹配关键字或正则的行 | input、keywords、pattern、maxItems |
| 条件继续 | 不满足条件时跳过下游节点 | input、mode（不为空/包含/正则）、value |
| Agent 任务 | 由工作台协调调用 AI Agent 插件的只读任务 | input、instructions、providerId、cwd |
| 结果汇总 | 合并上游输出生成报告 | title、input（留空合并全部上游）、format |

参数里的 `{{节点.字段}}` 在执行时替换为该节点的输出；单个占位符保留原始类型，数组和对象可以直接传给下一个节点。

## 邮件抓取说明

- 使用 Node 内置 net/tls 实现最小 IMAP：登录、SELECT、SEARCH（仅服务器侧日期条件）、FETCH `BODY.PEEK[]`、LOGOUT。
- 连接方式支持 tls（993，默认）、starttls（143）与 none；开启 SSL/TLS 时由 `tls.connect` 校验证书链。
- 中文关键字、主题与正文过滤在本地完成，避免依赖服务器的 SEARCH CHARSET。
- 正文支持 quoted-printable、base64、multipart 的多部分邮件，HTML 正文转换为纯文本。
- 账号与授权码只保存在本插件数据目录，列表接口不返回密码，日志与运行记录不记录凭据。

## Agent 由工作台协调

工作流只负责编排和节点参数，AI Agent 插件负责独立引擎、账户及任务执行；工作台通过通用 `desk.capabilities.v1` 负责能力发现、路由、校验和审批。插件不互相导入内部实现，宿主不包含业务逻辑。

1. 工作流通过工作台目录发现 `agent.task.start.v1`，生成任务句柄并固定所选提供方。
2. 启动接口立即返回，运行保持 `waiting`；界面以短请求调用 `agent.task.read.v1`，长期任务不占用单次 RPC。
3. 原生问题通过 `agent.task.respond.v1` 回答；只读任务不能批准写入或提权。成功后才执行下游。
4. 停止、停用或关闭时调用 `agent.task.cancel.v1`；迟到结果不能恢复已取消运行。重启不自动重放任务。

未填写工作目录时使用 AI 插件的隔离运行空间，填写时须为有效绝对目录；引擎安装与登录在 AI Agent 插件中配置。只有工作流包含 Agent 节点时提示缺失，可在“AI 能力”刷新提供方。多个提供方须在节点配置中明确选择。

错误码：`AGENT_PROVIDER_MISSING`（启用或升级 AI 插件）、`AGENT_PROVIDER_AMBIGUOUS`（选择提供方）、`AGENT_PROVIDER_INCOMPATIBLE`（任务状态或输出不符合契约）、`AGENT_TASK_FAILED`（查看 AI 任务失败原因）。

## 节点分类

每个节点同时带三个正交维度的标签，分类选择、连线校验与存储校验共用同一套标签。

| 维度 | 取值 | 含义 |
|---|---|---|
| 输入输出 `io` | `source` / `transform` / `sink` | 只产出 / 有入有出 / 只消费 |
| 功能 `kind` | `input` / `process` / `invoke` / `output` / `flow` | 数据输入、数据处理、AI 能力、结果输出、流程控制 |
| 流程 `role` | `start` / `step` / `end` | 开始、过程、终止 |

| 节点 | io | kind | role |
|---|---|---|---|
| `flow.start` 开始 | source | flow | start |
| `text.input` 文本输入 | source | input | step |
| `mail.fetch` 邮件读取 | source | input | step |
| `log.extract` 文本提取 | transform | process | step |
| `flow.gate` 条件继续 | transform | flow | step |
| `agent.review` Agent 任务 | transform | invoke | step |
| `result.collect` 结果汇总 | transform | process | step |
| `output.webhook` HTTP 回调 | sink | output | end |
| `output.file` 写入文件 | sink | output | end |
| `output.notify` 运行提醒 | sink | output | end |
| `flow.end` 终止 | sink | flow | end |

结构规则（保存时硬校验，连线时即时拒绝）：

- 开始节点不能有上游；输入节点只能接在开始节点之后（不接受数据上游，只接受控制流入口）。
- 终止节点与输出节点不能有下游；需要输入的节点必须有上游。
- 缺少开始或终止节点属于**兼容提示**，不阻断保存：运行时按“无上游的节点”推断入口，界面提供「补齐开始/终止节点」一键修正。
- 执行入口是开始节点，**不在其可达路径上的节点会被标记跳过**，不再被静默执行。

输出节点说明：`output.webhook` 只接受 http(s) URL，15 秒超时，非 2xx 视为节点失败；`output.file` 需要绝对路径并自动创建目录，支持覆盖/追加；`output.notify` 是**界面内提醒**——宿主没有给插件提供系统通知能力，所以它把提醒内容作为运行结果产出，展示在结果面板，不发操作系统通知。

## 运行机制（自动 / 手动 / 外部触发）

每条工作流都有 `trigger` 属性，取值三种：

| 运行方式 | 配置 | 行为 |
|---|---|---|
| 仅手动（默认） | `mode: manual` | 只在界面点「运行」时执行；**仍可被其他插件通过契约触发** |
| 固定时间 | `mode: once` + `at`（本地时间 `YYYY-MM-DD HH:mm`） | 到点执行一次；时间已过则不再触发，**不补跑** |
| 固定周期 | `mode: interval` + `every` + `unit` | 周期单位支持 `second / minute / hour / day / month / year` |

周期规则：

- 以「计划时间」为锚点推进，不会因每次运行耗时而漂移。
- 桌面或插件未运行期间错过的次数**直接跳过**，不会回放积压运行。
- 上一次运行未结束（含等待 Agent 的 `waiting`）时跳过本次并记日志，同一工作流不会并发运行。
- 按月/按年推进保留「日」，遇到短月夹到当月最后一天（1 月 31 日 + 1 个月 = 2 月 28/29 日）。

定时由**本插件自己的后台进程**执行（宿主不提供调度接口）。本插件默认是「首次使用时激活」，所以**桌面启动后到第一次打开本插件窗口之前不会触发**；需要开机即计时，请把插件清单 `loadOnStartup` 改为 `true`，重新打包并重新启用本插件（界面在启用自动触发时会给出同样的提示）。

对外契约 `workflow.run.v1`（供其他插件触发，不受运行方式限制）：

```text
入参：{ version: 1, workflowId }
返回：{ version: 1, runId }
```

## 数据与生命周期

- `plugin-data/work-flow/workflows.json`：工作流定义（含 `trigger`）。
- `plugin-data/work-flow/credentials.json`：邮件账号（含授权码）。
- `plugin-data/work-flow/runs/<workflowId>.json`：最近 20 次运行记录（节点输出超过 4000 字截断）。
- 运行在后台异步执行，RPC 立即返回 runId；逐节点写入历史并发出 `runs.changed` 事件（界面另有轮询兜底，避免漏事件后停在“运行中”）。
- 停用或退出时先阻断新任务再取消运行中的任务（含等待服务调用的 `waiting`），等待任务结束并归档；整个过程只涉及本插件。

## 约定与限制

- 执行是单节点串行的拓扑顺序，没有分支并行；每条工作流同时只能有一个运行中任务取消/查看的入口。
- 清单必须静态声明 `views`：宿主 `canOpen` 要求视图非空，否则点击桌面图标只会跳到配置页（本次实测踩到并已修正）。
- IMAP 凭据保存在本机，不使用系统钥匙串；传输内容取决于你填写的邮件服务器，请在可信网络中使用。
- 未实现的后续能力：并行分支、失败重试/恢复执行、节点级断点重跑、知识检索节点。
