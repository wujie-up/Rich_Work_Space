import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/main/common/nodes.js';

const agent = createRegistry({ credentials: {} }).get('agent.review');
const context = params => ({ params, variables: { requirement: { value: { title: '订单', count: 3 } } },
  value: name => params[name] });

test('Agent 输入映射保留对象和数字，角色与固定输出进入提示词', async () => {
  const request = await agent.prepare(context({ input: '', rolePrompt: '你是产品经理', instructions: '评审需求',
    inputMapping: '{"requirement":"{{requirement.value}}","attempt":2}', outputFields: '{"passed":"boolean","issues":"string[]"}' }));
  assert.match(request.prompt, /你是产品经理/);
  assert.match(request.prompt, /"count":3/);
  assert.match(request.prompt, /"attempt":2/);
  assert.match(request.prompt, /passed/);
  assert.deepEqual(agent.after({ output: '```json\n{"passed":false,"issues":["缺少规则"]}\n```', provider: 'ai' }, request).output,
    { passed: false, issues: ['缺少规则'] });
});

test('Agent 固定输出拒绝缺失字段、类型错误、未知路由与额外文本', async () => {
  const request = await agent.prepare(context({ input: '需求', outputFields: '{"passed":"boolean","route":["code","design"]}' }));
  for (const output of ['{}', '{"passed":"false","route":"code"}', '{"passed":true,"route":"other"}',
    '结论：{"passed":true,"route":"code"}']) {
    assert.throws(() => agent.after({ output, provider: 'ai' }, request), { code: 'AGENT_OUTPUT_INVALID' });
  }
});

test('固定输出由节点从旧版聚合文本末尾解析，忽略过程中的示例', async () => {
  const request = await agent.prepare(context({ input: '评审', outputFields: '{"passed":"boolean","summary":"string"}' }));
  for (const output of ['开始评审\n{"passed":false}\n评审完成\n{"passed":true,"summary":"通过"}',
    '示例：\n```json\n{"passed":false}\n```\n实际结论：\n```json\n{"passed":true,"summary":"通过"}\n```',
    '开始评审\n{\n  "passed": true,\n  "summary": "通过"\n}']) {
    assert.deepEqual(agent.after({ output, provider: 'ai' }, request).output, { passed: true, summary: '通过' });
  }
  for (const output of ['{"passed":true,"summary":"示例"}\n任务失败',
    '{"passed":true,"summary":"示例"}\n{"passed":false,',
    '```json\n{"passed":true,"summary":"示例"}\n```\n{"passed":false,']) {
    assert.throws(() => agent.after({ output, provider: 'ai' }, request), { code: 'AGENT_OUTPUT_INVALID' });
  }
});

test('旧 Agent 文本行为兼容，代码任务必须配置目录和文件范围', async () => {
  assert.deepEqual(agent.after({ output: '分析完成', provider: 'ai' }), { output: '分析完成', provider: 'ai', length: 4 });
  await assert.rejects(agent.prepare(context({ input: '修改代码', mode: 'code' })), { code: 'INVALID_ARGUMENT' });
  const request = await agent.prepare(context({ input: '修改代码', mode: 'code', cwd: '/tmp/project', files: 'a.js\nb.js' }));
  assert.deepEqual(request.files, ['a.js', 'b.js']);
  assert.equal(request.mode, 'code');
  assert.match(request.prompt, /a\.js/);
  assert.match(request.prompt, /b\.js/);
  assert.match(request.prompt, /范围外.*停止/);
});

test('非法字段定义与输入映射在发起 Agent 任务之前报错', async () => {
  for (const params of [{ input: 'x', outputFields: '{"passed":"bool"}' }, { inputMapping: 'invalid' }]) {
    await assert.rejects(agent.prepare(context(params)), { code: 'INVALID_ARGUMENT' });
  }
});
