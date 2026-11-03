# 每日10点 · 放款未回调订单巡检

导入 `payout-callback-audit.workflow.json`，需要工作流插件 `work-flow 0.5.61`。保存时间戳Markdown，并用飞书机器人原生表格卡片通知，不生成Excel，不调用模型搬运订单。

## 业务步骤与查看数据

场景：跨财务库和国家库的定时双重核对。主要矛盾：财务未回调候选不等于旧系统仍未回调，综合节点掩盖了筛选过程。展开后的每一步都实际执行，具有独立状态和结果。

| 节点 | 结果面板可查看的数据 |
| --- | --- |
| 每日10点开始 | 入口状态；定时设置在流程运行方式中 |
| 固定财务窗口 | 财务基准时间、最大事件ID、报告目录、快照查询request_id |
| 财务候选查询 | 全部候选事件、候选数、各页查询记录；含申请单、国家、时间、渠道 |
| 国家渠道分批 | 国家和proxy_id分组的去重申请单、分组数、每100单的批次数 |
| 国家库复核 | status=2明细、payment_code和application_time；每个国家渠道的申请数、命中数和查询次数 |
| 渠道国家汇总 | 渠道→国家→订单结构、渠道数、国家分组数、明细数 |
| 时间戳MD保存 | 报告路径、候选数、明细数、查询总数 |
| 飞书机器人通知 | 已确认成功的卡片段数及本地报告路径 |

财务或国家查询不完整时，当前节点失败，保留带“未完成”的MD，不继续通知。完整零记录仍生成报告并发送。完整候选事件仅保存在财务节点输出，不在分批节点复制；订单直接在原生节点间传递，模型调用数为0。原payout.audit综合节点继续可用。

## 安装与定时

升级插件后导入JSON，选择更新已有流程。导入沿用安全规则重置为手动：在“运行方式”选择“每日固定时间（北京时间）”，设置10:00，启用并保存。使用已支持automatic授权参数的新版宿主时，巡检Metabase查询自动授权，无需首次点击；其他任务保留原有确认规则。

启动已有Metabase / matabase-mcp服务。只有一个名称匹配的服务时服务ID可留空；存在多个时，在三个查询节点填写实际服务ID。报告保存到工作台的“桌面文件”，本机目录为 `/Users/wujie/Library/Application Support/Work Desk/desktop-files`，在“固定财务窗口”节点修改，后续步骤引用其变量。工作台和工作流后台需运行，停机错过时刻不补跑；休眠可能使执行延后。

文件名示例：`放款未回调订单-20261103-100000-123-运行ID.md`，北京时间戳，重试不覆盖。正文按渠道和国家分组，标题合并为一行，例如“渠道：pandapay 国家：阿根廷（AR）”，明细仅三列：老系统申请单ID、申请时间、渠道订单号。删除表格重复国家、渠道字段及旧系统订单ID、支付记录ID。正文不再输出“查询追溯”，查询记录保留在内部节点输出中。

## 飞书通知

选择“飞书机器人表格通知”节点，下方配置可修改Webhook和签名密钥。输入框均不回显，编辑留空保留原值。保存后发送图标测试已保存配置，测试消息不查询或包含业务订单。App ID/App Secret消息接收连接与此出站机器人独立。

配置保存在 `plugin-data/work-flow/feishu-robot.json`，不进入流程JSON、运行记录或插件包。用户提供的配置已保存，0.5.55曾成功发送明确标记的测试文本，结果见 `feishu-verification.json`；新版卡片尚未向实际群重复发送。

自定义机器人不提供任意HTML页面渲染，使用interactive消息、schema=2.0原生table组件实现表格。单元格为text，渠道订单号不执行链接、格式或@提醒。每表最多10条订单、每卡最多5表；长报告拆卡，续段重复渠道、国家和表头，每条明细仅出现一次。卡片结构预算15500字节，发送前检查所有签名请求不超过20000字节，最多60卡；MD文件上限1MiB，超限在发送前失败，不静默截断。卡间隔1秒，每请求总超时10秒，不跟随重定向。

签名参考 `sl-platform/dbai-sdk/dbai-sdk-feishu` 的 `FeiShuRobotNotifyUtil`：秒级timestamp、换行、secret组成HMAC-SHA256密钥，对空正文计算后Base64。HTTP成功且JSON code=0才确认成功。不记录地址、密钥、签名或正文。

发送失败不自动重试，保留MD并记录已确认成功的段数。网络异常时送达可能不确定，重试前需核对群；停止不能撤回已发送消息。每段发送前同步检查取消状态。配置更改作用于下一次发送，当前发送使用固定快照。

官方参考：[机器人消息](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)、[JSON2.0表格组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/table)。旧客户端可能需升级才能查看表格。

## 可配置超时与固定SQL口径

在“查询财务未回调候选”节点编辑“未回调超时（小时，1–744）”，默认6，支持整数小时。保存后下一轮使用新值，已开始的运行保留其参数快照。SQL严格比较创建时间早于固定基准时间减配置小时数，报告同步显示本轮阈值；最近一个月范围不变。旧payout.audit综合节点也支持该参数，缺省仍为6。通知的渠道订单号取loan_order_info.payment_code；申请时间取loan_application_info.application_time，不使用财务事件创建时间。

财务连接treasury中的 `financial.payment_channel_trade_event_record`：business_type='PAYOUT'、event_type='CALL'、event_result='SUCCESS'、callback_received=0、del_flag=0；本轮财务库时间前一个月以内，严格超过配置小时数（默认6）。以payment_channel.channel_code补渠道名称，不排除历史停用渠道。

旧库：loan_order_info.application_id=财务order_id，payment_record.order_id=loan_order_info.id。匹配国家及proxy_id，仅保留用户已确认的payment_record.status=2。通过loan_order_info.application_id关联loan_application_info.id，读取application_time；渠道订单号来自loan_order_info.payment_code，merchant_no是商户号，不用于通知。同国家、申请单、channel_code、proxy_id、支付记录的多条事件合并，取最早创建时间；不同渠道编码保留归属。

本轮固定财务时间和最大事件ID。ID由SQL CAST AS CHAR返回，全程字符串。按ID游标逐页读取，单页至多100行，不用OFFSET，满页或truncated继续。国家库按国家/渠道批次（至多100申请单）查询，再按支付记录ID分页。只有单条SELECT，不使用DATE_SUB、CTE、注释或写入。

未知国家、查询错误、游标不递增、结果格式错误都不得变成零订单成功。跨数据库不是同一事务快照。TH结构探测曾超时，未知映射明确失败，不猜测跳过。基准时间在报告中，逐页request_id在内部输出中。

SQL唯一源为插件 `src/main/common/payout-queries.js`，本目录queries.mjs重新导出。`.mcp.json`可直接传metabase_query；财务例子仅第一页，国家例子是AR关联样例，不代表整月结果。

## 验证

2026-11-03 11:56:06只读试跑：4064候选事件、16条复核明细、99次查询、complete=true，最终命中AR/CO/MY；这是当时快照。新版八节点和卡片测试使用模拟数据及HTTP，不重复执行真实业务通知。

新增验证覆盖八节点真实执行引擎、101申请单分批及满页继续、国家查询失败定位并阻断通知、三列MD、127行卡片拆分无遗漏、分组和表头重复、签名全请求体预检、后续段失败不重试。保留分页、SQL约束、ID精度、取消、授权拒绝、北京时间定时、流程导入重置手动的回归验证。

```sh
node --test plugin-dev/work-flow/test/payout-audit.test.js plugin-dev/work-flow/test/payout-node.test.js plugin-dev/work-flow/test/feishu-report.test.js plugin-dev/work-flow/test/feishu-robot.test.js plugin-dev/work-flow/test/feishu-output.test.js plugin-dev/work-flow/test/nodes.test.js plugin-dev/work-flow/test/workflow-transfer.test.js plugin-dev/work-flow/test/triggers.test.js docs/workflows/payout-callback-audit/queries.test.mjs
```
