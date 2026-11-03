# 现场验证记录

日期：2026-10-30。未重启 DeckPg，未修改生产数据、代码或 SLS 索引。

## 已验证

- 通过 SLS 实际项目库清单核对 57 个目标：老系统 16 国 50 库、新系统 7 库。
- 三项自动验证通过：可导入 JSON 与源码一致；57 库分组及当前协议校验；真实 Engine 中七组并行、汇合、失败/未知传递及三个文件输出。
- 已导入 DeckPg“运维巡检”分组，名称“新老系统 ERROR · 半小时巡检”。
- 修正定义后已更新原流程，并重新保存固定周期 30 分钟、启用自动触发；界面显示下次运行 `2026/10/30 11:17:01`。

## 真实 SLS 查询

统一查询窗口 `[1793325360, 1793327280)`，逐库调用现有服务的查询实现，语句为 `level: ERROR | SELECT count(*) AS errors LIMIT 1`。

52 库返回 `Complete`。下列 5 库返回 `ParameterInvalid`，其中抽样原始错误明确为 `level` 未配置键值索引：

| Project | Logstore |
| --- | --- |
| ai-kr | app |
| ai-kr | mgr |
| ai-my | worker |
| ai-saas | shortlink |
| ai-saas | useroperation |

尝试仅使用 SQL 的 `WHERE level = 'ERROR'` 仍被拒绝，不能作为替代。索引设置读取也不在当前凭据权限内。未尝试修改索引。定义要求这些情况记覆盖缺口，不能用裸 `ERROR` 全文搜索冒充等价统计。

## DeckPg 首轮联调

首次运行在“协调 Agent · 固定时间窗”立即失败，提示 AI 提供方缺失。已查明定义误填 `ai-agent`，实际安装并启用的插件 ID 是 `ai-agent-sessions`。已修正源码和导入文件，并增加相应校验。

用户协助完成 macOS 文件选择器后，已通过“更新：新老系统 ERROR · 半小时巡检”替换原定义，保留原运行历史，没有新增重复流程。

重新运行曾进入工作台“工作流后台 Agent 完全授权”弹窗，申请后台会话、生产 SLS 工具和浏览器权限并记住选择。已请求用户在桌面审核，未代点授权。随后弹窗消失，协调 Agent 完成并启动七个查询会话，界面可见 SLS 能力调用成功事件。

10:47:04 开始的真实运行已完成七组查询、汇合、去重分类、代码根因分析及三个文件输出。工作台桌面可见 `ERROR日志巡检-最新.md`。已核对桌面报告与归档文件逐字节一致（22,350 字节），状态文件可解析，记录 52 库完整、5 库失败，合计 57 库；已知 ERROR 177 条，其中 133 条归入需处理问题，44 条保留待核实。这些是日志条数，不是交易或事件数量。没有已确认的业务异常排除规则，因此未擅自排除未知异常。

主要发现包括 BR 风控写库缺少 `mobile_max_amount` 字段、VE 邮箱凭据错误、AR 支付回调关联未找到候选记录；报告分别给出证据、影响、根因判断及处理建议，未执行修复。五个失败库单列覆盖缺口，状态保持 `incomplete`，`watermarkAdvanceAllowed=false`，不会将失败时间窗当作已完整巡检。

输出位置（基于当前 Work Desk 数据目录）：

- 桌面：`desktop-files/ERROR日志巡检-最新.md`
- 归档：`plugin-data/work-flow/sls-error-monitor/reports/20261030-022800.md`
- 状态：`plugin-data/work-flow/sls-error-monitor/latest.json`

三项自动测试使用真实工作流 Engine 和模拟 Agent 验证编排；上述首轮结果来自 DeckPg 中的真实 Agent、真实 SLS 和本地只读代码分析。定时执行仍依赖 DeckPg 与工作流插件保持运行，睡眠时不会查询。

## 0.5.43 调度、过滤规则和连续时间窗

本节记录后续改版验证，不代表已安装到当前 DeckPg。现有插件、工作流定义和运行历史均未直接修改，未重启 DeckPg。

- 修复调度刷新会重新计算周期终点的问题：读取排期、保存无关流程保留原触发时间；修改触发规则才重新排期。此前历史中实际已有 11:17:01 的自动运行，不能将现象归因为完全没有定时能力。
- 关闭最后一个工作流窗口仍停止调度；补测停止与异步读取、启动交错时，不会启动剩余任务或重新创建定时器。
- 新增规则查询节点，将已确认规则按适用范围编译为 SLS 计数、聚合及样本查询；启停、条件组合、重复排除、特殊字符及现有 MCP 输入契约均有测试。默认规则为空，未擅自屏蔽生产异常。
- 时间窗固定为 `[上次成功结束时间, 当前执行时间)`，首次无历史取最近 30 分钟。失败或覆盖不完整保留未完成起点；关闭重开后读取持久化游标，不取整、不延迟、不截断为最近 24 小时。
- 报告和摘要保存成功，且 57 个库均完整覆盖本时间窗后，才推进游标；报告写入失败不推进。
- 真实 Engine 配合模拟 Agent 跑两轮完整覆盖及两轮部分失败，验证七组并行、汇合、过滤查询传递、连续时间窗、失败重查及桌面/归档报告一致。

验证命令与结果：

```sh
node --test plugin-dev/work-flow/test/triggers.test.js plugin-dev/work-flow/test/sls-monitor.test.js docs/workflows/sls-error-monitor/workflow.test.mjs
# 25 passed, 0 failed
node --test plugin-dev/work-flow/test/nodes.test.js plugin-dev/work-flow/test/engine.test.js plugin-dev/work-flow/test/parallel-review.test.js plugin-dev/work-flow/test/workflow-transfer.test.js plugin-dev/work-flow/test/plugin.test.js
# 55 passed, 0 failed
```

合计 80 项通过。新版 SQL 的本地生成和 MCP 参数校验通过；本次未重新执行新版真实 Agent/SLS 联调。上文五个日志库索引缺口仍然存在，未宣称已修复。

安装包 `plugin-dev/dist/work-flow-0.5.43.plg` 已构建，通过桌面包导入校验器验证 7,936 个文件的完整性；新增节点、调度器及节点注册源码与工作区一致，四处版本声明一致为 0.5.43。包大小 19,540,720 字节，SHA-256：`0419457a02aa8ae214012ff40145392fe39ab011beeaef8f39d6a296c4c85330`。尚未安装，更新流程后还需重新启用每 30 分钟调度。

## 0.5.45 关键日志及 Markdown 修复

- 查询提示词为每个问题保留本轮真实脱敏样本及来源、location、message、时间与请求标识；字段未取得时不推测。保存报告节点直接读取查询分支附录，分类及根因 Agent 无需重复传递完整样本。
- 使用文本插件实际依赖的 marked 验证截图问题：`**处理：**正文` 会保留星号；保存时将四种报告标签统一为 `**处理**：正文`，围栏及缩进代码块保持原文。
- 回归覆盖样本保留、优先级、缺失说明、日志内 Markdown 围栏、旧数据格式失败降级及桌面/归档一致。真实 Engine 配合模拟 Agent 验证七分支日志附录与完整/部分失败的连续两轮运行。
- 相关 83 项测试通过（0 失败、0 跳过）：sls-monitor、巡检 workflow、triggers、nodes、engine、parallel-review、workflow-transfer、plugin。没有重新查询生产 SLS 或运行真实 Agent。
- 只读加载当前桌面报告后，在内存中验证四种标签能正确解析；原报告、已安装插件、工作流定义及运行数据均未修改，未重启 DeckPg。

安装包 `plugin-dev/dist/work-flow-0.5.45.plg` 构建成功，通过桌面包导入校验器验证 7,937 个文件完整性，报告生成及保存源码与工作区一致。包大小 19,542,933 字节，SHA-256：`b84079278dfab80d89a332284f8251ad02bf1adbb21ad13affb5759eb73dd7a9`。

配套 `sls-error-monitor.workflow.json` 与生成源码一致。升级插件并更新该工作流后对新运行生效；导入前备份并保留自定义过滤规则，导入后重新启用原 30 分钟调度。历史报告和旧运行快照不自动改写。

## 0.5.46 报告时间后缀与防覆盖

- 桌面文件使用生成时的北京时间，格式为 `ERROR日志巡检-yymmdd-HH:mm.md`。兼容原 `ERROR日志巡检-最新.md` 配置，旧文件保留；此次命名调整只需升级插件，不必更新已有工作流。
- 使用独占创建保存报告，重名时追加 `-2`、`-3`，同时保护桌面报告和运行归档。同一分钟并发保存也不会覆盖。
- 22 项相关测试通过（sls-monitor、巡检 workflow、nodes），覆盖北京时间跨日、同分钟并发、跨分钟、旧文件保留、保存失败不推进游标及真实 Engine 的两轮报告保存。未重新运行生产查询，未安装或重启 DeckPg。
- 安装包 `plugin-dev/dist/work-flow-0.5.46.plg` 构建成功，通过桌面导入校验器验证 7,937 个文件完整性，保存节点源码与工作区一致。包大小 19,543,740 字节，SHA-256：`ee2770194b3c0ca56f6c62f4ba4ab5fe9727c9c9d4469c084697c57b7edad132`。
