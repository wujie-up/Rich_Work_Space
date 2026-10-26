import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createRegistry } from '../src/main/common/nodes.js';
import { graphIssues } from '../src/main/common/graph.js';

const registry = createRegistry({ credentials: { secret: async () => ({}) } });
const classify = typeId => registry.list().find(type => type.type === typeId) || {};

test('每个节点都带输入输出、功能、流程三个维度的标签', () => {
  const kinds = ['input', 'process', 'invoke', 'output', 'flow'];
  for (const type of registry.list()) {
    assert.ok(['source', 'transform', 'sink'].includes(type.io), `${type.type} 缺少合法的输入输出标签`);
    assert.ok(kinds.includes(type.kind), `${type.type} 缺少合法的功能标签`);
    assert.ok(['start', 'step', 'end'].includes(type.role), `${type.type} 缺少合法的流程标签`);
  }
});

test('节点按三维度落在预期位置', () => {
  const tag = type => { const found = registry.list().find(item => item.type === type); return `${found.io}/${found.kind}/${found.role}`; };
  assert.equal(tag('flow.start'), 'source/flow/start');
  assert.equal(tag('text.input'), 'source/input/step');
  assert.equal(tag('mail.fetch'), 'source/input/step');
  assert.equal(tag('log.extract'), 'transform/process/step');
  assert.equal(tag('flow.gate'), 'transform/flow/step');
  assert.equal(tag('agent.review'), 'transform/invoke/step');
  assert.equal(tag('result.collect'), 'transform/process/step');
  assert.equal(tag('output.webhook'), 'sink/output/end');
  assert.equal(tag('output.file'), 'sink/output/end');
  assert.equal(tag('output.notify'), 'sink/output/end');
  assert.equal(tag('flow.end'), 'sink/flow/end');
});

const graph = (nodes, edges) => graphIssues({ nodes, edges, classify });
const node = (id, type) => ({ id, type, title: id, x: 0, y: 0, params: {} });

test('结构规则：起止方向、缺上游、缺起止节点', () => {
  assert.deepEqual(graph([node('s', 'flow.start'), node('m', 'mail.fetch'), node('c', 'result.collect'),
    node('e', 'flow.end')], [{ from: 's', to: 'm' }, { from: 'm', to: 'c' }, { from: 'c', to: 'e' }]),
  { issues: [], warnings: [] });

  const backwards = graph([node('s', 'flow.start'), node('m', 'mail.fetch')], [{ from: 'm', to: 's' }]);
  assert.match(backwards.issues.join(), /开始节点不能有上游/);

  const fromData = graph([node('c', 'result.collect'), node('m', 'mail.fetch')], [{ from: 'c', to: 'm' }]);
  assert.match(fromData.issues.join(), /输入节点只能接在开始节点之后/);

  const outOfEnd = graph([node('c', 'result.collect'), node('e', 'flow.end'), node('w', 'output.webhook')],
    [{ from: 'c', to: 'e' }, { from: 'e', to: 'w' }]);
  assert.match(outOfEnd.issues.join(), /终止节点不能有下游/);

  const orphan = graph([node('s', 'flow.start'), node('x', 'log.extract')], []);
  assert.match(orphan.issues.join(), /需要上游输入/);
  assert.match(orphan.warnings.join(), /缺少终止节点/);
  assert.deepEqual(graph([node('x', 'log.extract'), node('e', 'flow.end')], [{ from: 'x', to: 'e' }]).warnings,
    ['缺少开始节点，运行时将按“无上游的节点”推断入口（旧工作流兼容）']);
});

async function resolve(typeId, params, parents = [], t) {
  const type = registry.get(typeId);
  const context = { runId: 'run', nodeId: 'n', params, timeoutMs: type.timeoutMs, shouldStop: () => false,
    parents: parents.map((output, index) => ({ nodeId: `p${index}`, output })),
    value: name => params[name], credential: async () => ({}) };
  return type.resolve(context);
}

test('HTTP 回调把上游内容发出去，失败时明确报错', async t => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      seen.push({ method: request.method, body });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });
  await new Promise(resolveListener => server.listen(0, '127.0.0.1', resolveListener));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const output = await resolve('output.webhook', { url, method: 'POST', body: '' }, ['ERROR 连接池耗尽'], t);
  assert.equal(output.status, 200);
  assert.deepEqual(seen, [{ method: 'POST', body: 'ERROR 连接池耗尽' }]);
  await assert.rejects(resolve('output.webhook', { url: 'ftp://x', method: 'POST', body: '' }, ['x'], t),
    { code: 'INVALID_ARGUMENT' });
});

test('写入文件落盘，追加模式保留历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wf-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'nested', 'report.txt');
  const first = await resolve('output.file', { path: target, mode: 'overwrite', content: '' }, ['第一份报告'], t);
  assert.equal(first.path, target);
  assert.equal(await readFile(target, 'utf8'), '第一份报告');
  await resolve('output.file', { path: target, mode: 'append', content: '' }, ['第二份报告'], t);
  assert.match(await readFile(target, 'utf8'), /第一份报告[\s\S]*第二份报告/);
  await assert.rejects(resolve('output.file', { path: 'relative.txt', mode: 'overwrite', content: '' }, ['x'], t),
    { code: 'INVALID_ARGUMENT' });
});

test('运行提醒产出标题与内容，缺内容时报错', async t => {
  const output = await resolve('output.notify', { title: '告警', content: '' }, ['ERROR 订单失败'], t);
  assert.equal(output.title, '告警');
  assert.match(output.body, /订单失败/);
  await assert.rejects(resolve('output.notify', { title: '告警', content: '' }, [], t), { code: 'INVALID_ARGUMENT' });
});

test('终止节点收集上游内容作为最终结果', async t => {
  const output = await resolve('flow.end', { input: '' }, ['关键日志：ERROR A', '结论：重启连接池'], t);
  assert.match(output.final, /ERROR A/);
  assert.match(output.final, /重启连接池/);
});
