import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { createRegistry } from '../src/main/common/nodes.js';
import { queryParameters } from '../../mcp/examples/sls/server.mjs';
import { marked } from '../../text-editor/node_modules/marked/lib/marked.esm.js';

const registry = createRegistry({ credentials: {} });
const targets = ['app', 'mgr'].map(logstore => ({ system: 'old', country: 'br', region: 'us-west-1', project: 'ai-br', logstore }));
const rule = { id: 'confirmed-1', enabled: true, reason: '已确认的预期业务拒绝', scope: { country: 'br', logstore: 'app' },
  conditions: [{ field: 'message', operator: 'contains', value: "customer's expected rejection" }] };
const resolve = (type, params) => {
  const values = type === 'sls.checkpoint' ? { report: '# 巡检报告', reportPath: join(params.stateDirectory, 'desktop', 'latest.md'), ...params } : params;
  return registry.get(type).resolve({ params: values, value: name => values[name], runId: 'test', nodeId: type });
};
const complete = window => ({ query: { output: { coverage: targets.map(target => ({ ...target, from: window.from, to: window.to,
  status: 'complete', patternsComplete: true, errorCount: 0 })) } } });

test('规则按范围生成计数、聚合及样本过滤条件，默认及停用规则不屏蔽日志', async () => {
  const plan = await resolve('sls.query-plan', { targets, rules: JSON.stringify([rule, { ...rule, id: 'disabled', enabled: false }]) });
  const [app, mgr] = plan.countries.br;
  assert.deepEqual(app.ruleIds, ['confirmed-1']);
  assert.match(app.queries.patterns, /WHERE NOT/);
  assert.match(app.queries.patterns, /strpos\(coalesce\("message", ''\), 'customer''s expected rejection'\) > 0/);
  assert.match(app.queries.count, /AS excludedErrors/);
  assert.ok(app.queries.samples.includes(app.predicate));
  assert.deepEqual(mgr.ruleIds, []);
  assert.doesNotMatch(mgr.queries.patterns, /WHERE/);
  for (const target of plan.targets) {
    for (const query of Object.values(target.queries)) {
      assert.doesNotThrow(() => queryParameters({ query, from: 100, to: 200 }));
    }
  }
  const empty = await resolve('sls.query-plan', { targets, rules: '[]' });
  assert.ok(empty.targets.every(target => target.ruleIds.length === 0));
});

test('非法或空条件规则不能变成排除全部，特殊字符串不能注入SQL或破坏现有MCP契约', async () => {
  for (const invalid of [{ ...rule, conditions: [] }, { ...rule, scope: { countries: ['br'] } },
    { ...rule, conditions: [{ field: 'message', operator: 'regex', value: '*' }] }, { ...rule, enabled: 'true' }, { ...rule, scope: 12 }]) {
    await assert.rejects(resolve('sls.query-plan', { targets, rules: [invalid] }), { code: 'INVALID_ARGUMENT' });
  }
  const plan = await resolve('sls.query-plan', { targets, rules: [{ ...rule,
    conditions: [{ field: 'message', operator: 'equals', value: "x'; DROP TABLE log; -- 中文 /*" }] }] });
  for (const query of Object.values(plan.targets[0].queries)) {
    assert.doesNotThrow(() => queryParameters({ query, from: 100, to: 200 }));
    assert.doesNotMatch(query, /DROP TABLE/);
  }
});

test('首次最近30分钟，完整报告落盘后从上次结束秒接续到当前秒', async t => {
  const storage = await temporaryStore(t);
  let now = 1800000123;
  t.mock.method(Date, 'now', () => now * 1000);
  const window = await resolve('sls.window', { stateDirectory: storage.root });
  assert.equal(window.to, now);
  assert.equal(window.from, now - 1800);
  const result = await resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets,
    groups: complete(window), summary: { fingerprints: [{ fingerprint: 'issue-1' }] } });
  assert.equal(result.advanced, true);
  now += 2067;
  const next = await resolve('sls.window', { stateDirectory: storage.root });
  assert.equal(next.from, window.to);
  assert.equal(next.to, now);
  assert.equal(next.previous.fingerprints[0].fingerprint, 'issue-1');
  assert.equal(JSON.parse(await readFile(join(storage.root, 'cursor.json'), 'utf8')).windowTo, window.to);
});

test('查询失败、部分覆盖或进程重开仍保留未完成起点，不能跳过缺失窗口', async t => {
  const storage = await temporaryStore(t);
  let now = 1800000123;
  t.mock.method(Date, 'now', () => now * 1000);
  const first = await resolve('sls.window', { stateDirectory: storage.root });
  now += 1800;
  const retry = await resolve('sls.window', { stateDirectory: storage.root });
  assert.equal(retry.from, first.from, '没有完成提交时模拟重启仍接续首轮起点');
  const groups = complete(retry);
  groups.query.output.coverage[1].patternsComplete = false;
  const result = await resolve('sls.checkpoint', { stateDirectory: storage.root, window: retry, targets, groups, summary: {} });
  assert.equal(result.advanced, false);
  now += 1800;
  assert.equal((await resolve('sls.window', { stateDirectory: storage.root })).from, first.from);
});

test('状态损坏不能默认为首次；旧版不完整覆盖从原窗口起点重查', async t => {
  const storage = await temporaryStore(t);
  t.mock.method(Date, 'now', () => 1800000123000);
  await writeFile(join(storage.root, 'latest.json'), JSON.stringify({ windowTo: 1799999000, windowFrom: 1799997000,
    watermarkAdvanceAllowed: false, fingerprints: [] }));
  assert.equal((await resolve('sls.window', { stateDirectory: storage.root })).from, 1799997000);
  await writeFile(join(storage.root, 'cursor.json'), 'not json');
  await assert.rejects(resolve('sls.window', { stateDirectory: storage.root }), { code: 'SLS_STATE_FAILED' });
});


test('报告按北京时间命名，同分钟并发及跨分钟保存均不覆盖已有报告或归档', async t => {
  const storage = await temporaryStore(t);
  let now = Date.parse('2026-10-30T16:05:00Z');
  t.mock.method(Date, 'now', () => now);
  const window = await resolve('sls.window', { stateDirectory: storage.root });
  const reportPath = join(storage.root, 'ERROR日志巡检-最新.md');
  await writeFile(reportPath, '# 原报告');
  const groups = complete(window);
  groups.query.output.coverage[0].status = 'failed';
  const results = await Promise.all(['# 第一份', '# 第二份', '# 第三份'].map(report => resolve('sls.checkpoint', {
    stateDirectory: storage.root, window, targets, groups, summary: {}, reportPath, report
  })));
  assert.deepEqual(results.map(result => result.reportPath).sort(), [
    'ERROR日志巡检-261031-00:05-2.md', 'ERROR日志巡检-261031-00:05-3.md', 'ERROR日志巡检-261031-00:05.md'
  ].map(name => join(storage.root, name)).sort());
  assert.equal(new Set(results.map(result => result.archivePath)).size, 3);
  now += 60000;
  const next = await resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets, groups, summary: {},
    reportPath, report: '# 下一分钟' });
  assert.equal(next.reportPath, join(storage.root, 'ERROR日志巡检-261031-00:06.md'));
  assert.equal(await readFile(next.reportPath, 'utf8'), '# 下一分钟');
  for (const [index, result] of results.entries()) {
    const expected = ['# 第一份', '# 第二份', '# 第三份'][index];
    assert.equal(await readFile(result.reportPath, 'utf8'), expected);
    assert.equal(await readFile(result.archivePath, 'utf8'), expected);
  }
  assert.equal(await readFile(reportPath, 'utf8'), '# 原报告');
});

test('报告保存失败时不得推进游标，成功保存后报告与归档一致', async t => {
  const storage = await temporaryStore(t);
  t.mock.method(Date, 'now', () => 1800000123000);
  const window = await resolve('sls.window', { stateDirectory: storage.root });
  const blocked = join(storage.root, 'blocked');
  await writeFile(blocked, 'not a directory');
  const reportPath = join(blocked, 'report.md');
  await assert.rejects(resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets,
    groups: complete(window), summary: {}, reportPath }));
  assert.equal(JSON.parse(await readFile(join(storage.root, 'cursor.json'), 'utf8')).windowTo, undefined);
  const result = await resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets,
    groups: complete(window), summary: {}, report: '# 实际报告' });
  assert.equal(result.advanced, true);
  assert.equal(await readFile(result.reportPath, 'utf8'), '# 实际报告');
  assert.equal(await readFile(result.archivePath, 'utf8'), '# 实际报告');
});

test('报告修正中文加粗标签，保留代码块和缩进日志原文', async t => {
  const storage = await temporaryStore(t);
  const window = await resolve('sls.window', { stateDirectory: storage.root });
  const code = '- **处理：**这是日志原文';
  const report = '# 巡检\n\n- **处理：**临时只读核对。\n- **根因： **仍待验证。\n- **证据：** 已有证据。\n\n'
    + `\`\`\`text\n${code}\n\`\`\`\n\n~~~~text\n${code}\n~~~~\n\n    ${code}\n`;
  const result = await resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets,
    groups: complete(window), summary: {}, report });
  const saved = await readFile(result.reportPath, 'utf8');
  const html = marked.parse(saved);
  assert.match(html, /<strong>处理<\/strong>：临时只读核对/);
  assert.match(html, /<strong>根因<\/strong>：仍待验证/);
  assert.match(html, /<strong>证据<\/strong>：已有证据/);
  assert.ok(saved.includes(`\`\`\`text\n${code}\n\`\`\``));
  assert.ok(saved.includes(`~~~~text\n${code}\n~~~~`));
  assert.ok(saved.includes(`    ${code}`));
  assert.equal(saved, await readFile(result.archivePath, 'utf8'));
});

test('即使分析正文省略日志，报告仍保留查询样本、来源和过滤字段，缺失样本明确说明', async t => {
  const storage = await temporaryStore(t);
  const window = await resolve('sls.window', { stateDirectory: storage.root });
  const groups = complete(window);
  const sample = { source: targets[0], time: '2026-10-30T03:00:00Z', location: 'Example.java:42',
    message: 'Unknown column `amount`\n```\n# 这是日志，不是标题', requestId: 'trace-example', slsRequestId: 'sls-example' };
  groups.query.output.findings = [
    { fingerprint: 'UNKNOWN-1', priority: 'P2', title: '认证失败', samples: [], sampleUnavailableReason: '查询权限不足' },
    { fingerprint: 'DATA-1', priority: 'P1', title: '写库缺列', samples: [sample] }
  ];
  const result = await resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets, groups,
    summary: {}, report: '# 巡检\n\n分析正文不含日志。' });
  const saved = await readFile(result.reportPath, 'utf8');
  assert.match(saved, /关键日志与过滤定位/);
  assert.ok(saved.indexOf('DATA-1') < saved.indexOf('UNKNOWN-1'), '日志证据按问题优先级排序');
  const blocks = marked.lexer(saved).filter(token => token.type === 'code');
  assert.equal(blocks.length, 1, '日志中的反引号不得破坏代码块');
  assert.deepEqual(JSON.parse(blocks[0].text), sample, '原始脱敏字段和值完整保留，不被二次摘要');
  assert.match(saved, /location/);
  assert.match(saved, /message/);
  assert.match(saved, /查询权限不足/);
  assert.equal(saved, await readFile(result.archivePath, 'utf8'));
});

test('旧查询结果的非数组samples不会丢失分析正文，附录失败显式提示并记录运行标识', async t => {
  const storage = await temporaryStore(t);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const window = await resolve('sls.window', { stateDirectory: storage.root });
  const groups = complete(window);
  groups.query.output.findings = [{ fingerprint: 'OLD', samples: '旧格式' }];
  const result = await resolve('sls.checkpoint', { stateDirectory: storage.root, window, targets,
    groups, summary: {}, report: '# 原分析正文' });
  const saved = await readFile(result.reportPath, 'utf8');
  assert.ok(saved.startsWith('# 原分析正文'));
  assert.match(saved, /关键日志附录生成失败/);
  assert.equal(errors[0][0], 'sls-report-format-failed');
  assert.equal(errors[0][1].runId, 'test');
  assert.match(errors[0][1].stack, /TypeError/);
  assert.equal(result.advanced, true, '新增附录失败不改变原覆盖判定');
});

test('损坏结构与空目标清单明确报错，不能推进水位', async t => {
  const storage = await temporaryStore(t);
  await writeFile(join(storage.root, 'cursor.json'), 'null');
  await assert.rejects(resolve('sls.window', { stateDirectory: storage.root }), { code: 'SLS_STATE_FAILED' });
  await assert.rejects(resolve('sls.query-plan', { targets: [], rules: [] }), { code: 'INVALID_ARGUMENT' });
});
