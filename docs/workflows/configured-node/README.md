# 通用可配置节点：JavaScript / Python

需要 work-flow 0.5.60。新增且仅新增一个节点类型 `custom.configured`，显示名称为“自定义节点”。场景是业务规则频繁变化的确定性自动化；解决“每个业务步骤都必须新增节点源码和发布”的矛盾。业务名称由画布节点名称决定，底层能力由配置选择。原财务、SLS及其他工作流保留兼容，本次不迁移现有流程。

## 使用

添加节点 → 数据处理 → 自定义节点。设置执行模式、输入及配置JSON。所有模式统一输出 `value`，下游用 `{{节点ID.value}}` 获取对象、数组或字符串，不经过模型。

- 数据处理：配置筛选、字段选择、分组、去重、排序、分批、关联。
- MCP工具调用：配置服务ID、工具名及参数，通过现有宿主能力授权通道调用，支持串行批量与游标分页。
- Markdown报告模板：配置分组层级及展示列，返回Markdown正文；配置directory时额外保存文件并返回path，可接已有飞书通知节点。
- 脚本执行：选择JavaScript或Python，填写函数体，读取input、params并return JSON值。

输入直接填上游变量，如 `{{source.value}}`。如果需要多个上游，填写“输入映射JSON”（填写后代替输入）：

```json
{"left":"{{finance.value}}","right":"{{countries.value}}"}
```

完整变量保留类型，缺失变量报错。配置和代码保存在节点及工作流JSON中，沿用现有导入导出作为模板，不需要增加业务节点类型。代码不会做 `{{...}}` 插值，避免把输入当成代码。配置中的输入映射及脚本params支持显式变量引用。

## JavaScript

配置JSON作为params，例如 `{"status":2}`。代码填写函数体，支持await及动态import，不需要定义或导出main：

```js
console.log('开始模拟筛选');
return input.filter(row => row.status === params.status);
```

JavaScript使用工作台当前Node/Electron运行时，不依赖系统Agent或系统Node CLI。JS执行进程设置128MiB的V8堆上限；这不是整个进程的总内存上限。

## Python

同样填写函数体，不需要def main：

```python
print('开始模拟筛选')
return [row for row in input if row['status'] == params['status']]
```

Python使用本机已安装解释器，可在节点填写可执行文件路径；不填写时macOS默认 `/usr/bin/python3`，Linux默认 `python3`。不会自动下载Python或依赖。解释器缺失时明确失败。Python以隔离模式启动，支持标准库；第三方库需要安装在选定解释器环境。当前实际验证平台是macOS，Linux分支未做实机验收，Windows未实现脚本进程管理。

脚本可访问本机资源，只运行可信脚本；进程隔离不是权限沙箱。脚本不继承完整父环境或自动注入机器人/MCP凭据。持久文件请使用明确路径，不依赖宿主当前目录。大整数ID使用字符串，跨语言返回不安全整数会明确失败。Python函数体为同步执行；异步任务可由函数体自行使用asyncio组织。

每次执行有独立监督进程组，监督进程不运行用户代码。超时、取消、插件停止时清理整组；父进程崩溃且尚未登记PID时，通过父管道EOF自行清理。完整结果使用独立JSON行管道，console/print日志单独返回，不会混入JSON；函数返回后清理后代，不等待后台任务。日志在stdout/stderr字段查看。

## 数据处理配置

```json
{
  "operations": [
    {"op":"filter","field":"status","operator":"equals","value":2},
    {"op":"unique","by":["country","id"]},
    {"op":"sort","by":[{"field":"createdAt","direction":"asc"}]},
    {"op":"select","fields":{"applicationId":"id","country":"country","merchant":"merchant_no"}}
  ]
}
```

支持filter的equals、not-equals、in、contains、lt、lte、gt、gte；equals不隐式转换类型。分组：`{"op":"group","by":["country","channel"]}`，输出 `{key,items}` 数组。分批：`{"op":"batch","by":["country","channel"],"size":100}`，国家渠道之间不会混批。关联需要输入 `{left:[],right:[]}`，例如 `{"op":"join","leftKey":"id","rightKey":"order_id","as":"payment","kind":"inner"}`；也支持left关联及等长的复合字段数组。未命中的left关联字段为null。

## MCP配置

示例不指向真实库；需要替换为已配置服务和实际SELECT：

```json
{
  "serviceId":"你的MCP服务ID",
  "tool":"metabase_query",
  "arguments":{
    "database":"实际连接名称",
    "sql":"SELECT CAST(id AS CHAR) AS id FROM sample WHERE id > {{cursor}} AND status = {{status}} ORDER BY id LIMIT 100",
    "limit":100
  },
  "bindings":{"status":{"type":"integer","value":2}},
  "resultPath":"rows",
  "pagination":{"cursorField":"id","cursorType":"integer","initial":"0","pageSize":100,"maxPages":10000}
}
```

arguments.sql使用类型化绑定，支持integer、number、boolean、string及null。占位符不加引号、不用作表名/列名；模板不支持注释符号、dollar/q引用。文本绑定不包含反斜线或控制字符。integer支持十进制字符串，避免ID精度损失。其他参数字段按普通变量映射解析；不要把不可信文本拼进其他字段中的SQL。

分页按游标严格递增、满页继续、短页且未截断才完成；空页仍标记截断、游标不前进、达到maxPages、累计结果超限都会失败。未配置分页却返回truncated=true也失败，不把部分结果作为完整成功。Metabase矩阵rows按columns名称转换为对象。

配置forEach=true后，数组输入逐项串行调用，每项单独重置游标；通过 `{{input.country}}` 等读取当前项，SQL变量放到bindings.value。默认合并返回行；includeInput=true时保留每项的输入关联，防止丢失国家等上下文。服务ID留空仅在有唯一MCP服务时可自动选择；工具按服务描述校验，不会自动猜测。工具执行规则和授权由宿主及对应服务负责，节点不绕过审批，不自动重试。

## 报告配置

```json
{
  "title":"模拟订单复核",
  "groupBy":[{"field":"channel","label":"渠道"},{"field":"country","label":"国家"}],
  "columns":[{"field":"applicationId","label":"老系统申请单ID"},{"field":"createdAt","label":"创建时间"},{"field":"merchant","label":"渠道订单号"}]
}
```

按需增加directory绝对路径，保存带北京时间戳和随机后缀的MD，返回path，不覆盖旧文件。无directory时仅返回正文。最多4级分组、30展示列，字段值转义，零记录有明确说明。接飞书时将通知节点reportPath设置为 `{{report.path}}`；飞书原有文件大小限制仍为1MiB。

## 限制与验证

脚本/MCP超时1–300秒，默认30秒；节点输入1MiB，配置/代码各128KiB，输出4MiB，单路脚本日志64KiB。超限明确失败，不静默截断。关联在构造过程中限制4MiB/10万行，避免先构造巨大笛卡尔积。MCP单页1–100行，maxPages至多10000；数据处理最多30步骤，分批最多1000条。

提供两个独立、默认手动的测试流程：

- `orders-script.workflow.json`：模拟订单 → JS筛选 → Python整理 → 通用分组报告。
- `inventory-config.workflow.json`：模拟库存 → 纯配置筛选排序 → 通用报告。

两份均在独立临时数据目录通过真实工作流引擎执行。仅用模拟数据，不查生产库、不调用模型、不发送飞书。原财务流程没有被修改。实际DeskPG Helper运行时也已验证JS/Python结果，保留大整数ID字符串。Chromium覆盖明暗主题、320/900窗口、语言字段切换、键盘焦点及禁用状态。

已知既有回归限制：`test/plugin.test.js` 的“启用固定周期后插件会自动触发，停用后停止”仍将triggers.options期望写成不含daily，和此前每日调度实现不一致；本次不修改该范围外断言。
