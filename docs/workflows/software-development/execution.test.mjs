import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Engine } from '../../../plugin-dev/work-flow/src/main/common/engine.js';
import { Runs } from '../../../plugin-dev/work-flow/src/main/common/runs.js';
import { createRegistry } from '../../../plugin-dev/work-flow/src/main/common/nodes.js';
import { Workflows } from '../../../plugin-dev/work-flow/src/main/common/workflows.js';
import { buildWorkflows } from './workflows.mjs';

const checklist = Array.from({ length: 10 }, (_, i) => ({ id: `R${i + 1}`, requirementId: `REQ-${i + 1}`,
  criterion: `检查项 ${i + 1}`, verification: '核对真实证据' }));
const review = (score = 100, blockers = [], questions = []) => ({ score, blockers, questions, summary: '逐项评审',
  checks: checklist.map((item, i) => ({ id: item.id, approved: i < score / 10, evidence: 'fixture evidence', reason: '核对' })) });
const decision = route => ({ route, reconciled: route === 'aligned', summary: '汇总', issues: [], questions: [], resolvedIssueIds: [] });

// Stub only the external Agent; graph scheduling, routing, checkpoints and file output use the real plugin Engine.
async function fixture(t, file, customize = () => undefined) {
  const storage = await temporaryStore(t);
  const registry = createRegistry({ credentials: {} });
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: type => registry.list().find(node => node.type === type) });
  const definition = buildWorkflows().find(entry => entry.file.startsWith(file)).document.workflow;
  const workflow = await workflows.save(definition);
  const calls = [];
  const counts = {};
  const outputDirectory = join(storage.root, 'artifacts');
  const agents = { cancel: async () => {}, run: async (request, { nodeId }) => {
    const count = counts[nodeId] = (counts[nodeId] || 0) + 1;
    calls.push({ nodeId, count, request });
    let output;
    if (nodeId === 'preflight') {
      output = { state: 'ready', projectDirectory: storage.root, outputDirectory, allowedFiles: 'src/app.js\ntest/app.test.js',
        evidenceFiles: '.deckpg/test-evidence.md\n.deckpg/acceptance-evidence.md', requirements: '原始需求 REQ-1', analysis: '既有需求分析',
        design: '既有设计', cases: '既有用例', defects: 'DEF-1 既有缺陷', testEnvironment: '本地测试环境', decisions: [], questions: [] };
    } else if (nodeId.endsWith('-author')) {
      output = { state: 'ready', artifact: [`${nodeId} round ${count}\n${'完整正文'.repeat(3200)}\nEND-${nodeId}-${count}`],
        summary: '本轮完整产物', checklist, decisions: [], questions: [], allowedFiles: 'src/app.js\ntest/app.test.js', evidence: ['fixture evidence'], resolutions: [] };
    } else if (nodeId.includes('-review-')) {
      output = review();
    } else {
      output = decision('aligned');
    }
    output = await customize({ nodeId, count, request, output, calls }) ?? output;
    return { state: 'succeeded', output: JSON.stringify(output) };
  } };
  const create = () => new Engine({ registry, runs: new Runs({ storage, pluginId: 'work-flow' }), credentials: {}, agents,
    emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
  const engine = create();
  t.after(() => engine.stop('test'));
  const started = await engine.start(workflow);
  const id = started.id;
  await engine.active.get(id).task;
  async function submit(text, file) {
    const pending = engine.records.get(id).pending;
    return engine.complete(id, pending.nodeId, { requestId: pending.request.form.id, text, ...(file ? { file } : {}) });
  }
  const url = 'https://example.invalid/private/requirements';
  await submit(url, { name: '需求链接', size: url.length, url });
  await submit(JSON.stringify({ projectDirectory: storage.root, outputDirectory }));
  return { engine, id, workflow, calls, counts, outputDirectory, create, submit };
}

async function drive(engine, id) {
  for (let i = 0; i < 150; i += 1) {
    const run = engine.get(id);
    assert.notEqual(run.status, 'failed', JSON.stringify(run.error));
    if (run.status !== 'waiting' || run.pending.kind !== 'service') { return run; }
    await engine.resume(id);
  }
  assert.fail('流程未在预期节点结束或等待');
}

function outputs(f) { return f.engine.active.get(f.id).outputs; }

test('89分不放行，90分通过；下一轮保留超过截断长度的完整产物及各角色意见', async t => {
  const f = await fixture(t, '01-', ({ nodeId, count }) => nodeId === 's1-review-product' ? review(count === 1 ? 89 : 90) : undefined);
  const run = await drive(f.engine, f.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(f.counts['s1-author'], 2);
  const prompt = f.calls.find(call => call.nodeId === 's1-author' && call.count === 2).request.prompt;
  assert.match(prompt, /END-s1-author-1/);
  assert.match(prompt, /score\\?":89/);
  assert.match(outputs(f).end.final, /status=aligned/);
  assert.match(await readFile(join(f.outputDirectory, '01-需求分析文档.md'), 'utf8'), /END-s1-author-2/);
});

test('100分但有阻断，即使协调Agent误报aligned仍不能放行；连续两轮无进展暂停', async t => {
  const f = await fixture(t, '00-', ({ nodeId }) => nodeId === 's1-review-testing' ? review(100, ['存在阻断']) : undefined);
  let run = await drive(f.engine, f.id);
  assert.equal(run.pending.kind, 'loop');
  assert.equal(f.counts['s1-author'], 3);
  assert.equal(run.pending.reason, 'no-progress');
  assert.equal(f.counts['s2-author'], undefined);
  run = await f.engine.decideLoop(f.id, 'exit');
  assert.equal(run.status, 'succeeded');
  assert.match(outputs(f).end.final, /status=unfinished/);
  assert.doesNotMatch(outputs(f).end.final, /status=aligned/);
  assert.equal(f.counts['s2-author'], undefined);
});

test('前三阶段各自循环，后续自动接续最新分析/设计/用例，不重复要求用户填写', async t => {
  const f = await fixture(t, '00-', ({ nodeId, count }) => /^s[123]-review-product$/.test(nodeId) && count === 1 ? review(80) : undefined);
  const run = await drive(f.engine, f.id);
  assert.equal(run.status, 'succeeded');
  for (let number = 1; number <= 3; number += 1) { assert.equal(f.counts[`s${number}-author`], 2); }
  for (let number = 4; number <= 7; number += 1) {
    if (number === 6) { assert.equal(f.counts['s6-author'], undefined); continue; }
    const request = f.calls.find(call => call.nodeId === `s${number}-author`).request;
    assert.match(request.prompt, /END-s1-author-2/);
    assert.match(request.prompt, /END-s2-author-2/);
    assert.match(request.prompt, /END-s3-author-2/);
    assert.equal(request.mode, 'code');
    assert.deepEqual(request.files, number === 4 ? ['src/app.js', 'test/app.test.js']
      : ['.deckpg/test-evidence.md', '.deckpg/acceptance-evidence.md']);
  }
  assert.match(await readFile(join(f.outputDirectory, '07-验收报告.md'), 'utf8'), /END-s7-author-1/);
  assert.match(outputs(f).end.final, /status=aligned/);
});

test('评审存在无法决策的问题时才介入，回答后回到作者修订', async t => {
  const f = await fixture(t, '02-', ({ nodeId, count, output }) => {
    if (nodeId === 's2-review-product' && count === 1) { return review(100, [], ['业务规则选 A 还是 B？']); }
    if (nodeId === 's2-decision' && count === 1) { return { ...decision('clarify'), questions: ['业务规则选 A 还是 B？'] }; }
    return output;
  });
  const waiting = await drive(f.engine, f.id);
  assert.equal(waiting.pending.nodeId, 's2-review-questions');
  await f.submit('选 A');
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  assert.match(f.calls.find(call => call.nodeId === 's2-author' && call.count === 2).request.prompt, /选 A/);
});

test('真实Engine同时发起三角色评审，并等待全部结果才汇合', async t => {
  const waiting = new Map();
  const f = await fixture(t, '01-', ({ nodeId, output }) => nodeId.includes('-review-')
    ? new Promise(resolve => waiting.set(nodeId, () => resolve(output))) : output);
  await f.engine.resume(f.id);
  await f.engine.resume(f.id);
  const poll = f.engine.resume(f.id);
  for (let i = 0; i < 100 && waiting.size !== 3; i += 1) { await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(waiting.size, 3);
  const done = [...waiting.values()];
  done[0](); done[1]();
  assert.equal(f.counts['s1-decision'], undefined);
  done[2]();
  await poll;
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
});

test('测试失败进入修复，再测试接收完整缺陷与修复记录；写任务串行', async t => {
  const f = await fixture(t, '08-', ({ nodeId, count }) => nodeId === 's5-review-testing' && count === 1 ? review(80, ['DEF-1 未修复']) : undefined);
  const run = await drive(f.engine, f.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(f.counts['s5-author'], 2);
  assert.equal(f.counts['s6-author'], 1);
  const fix = f.calls.find(call => call.nodeId === 's6-author');
  assert.match(fix.request.prompt, /END-s5-author-1/);
  assert.deepEqual(fix.request.files, ['src/app.js', 'test/app.test.js']);
  const retest = f.calls.find(call => call.nodeId === 's5-author' && call.count === 2);
  assert.match(retest.request.prompt, /END-s5-author-1/);
  assert.match(retest.request.prompt, /END-s6-author-1/);
  assert.ok(f.calls.indexOf(fix) < f.calls.indexOf(retest));
});

test('验收90分不通过，独立测试/修复/验收各自产出，不隐式触发其他阶段', async t => {
  for (const file of ['05-', '06-', '07-']) {
    const f = await fixture(t, file, ({ nodeId }) => nodeId === 's7-review-product' ? review(90) : undefined);
    assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
    const number = Number(file.slice(0, 2));
    assert.match(outputs(f).end.final, number === 7 ? /status=unfinished/ : /status=aligned/);
    assert.deepEqual(Object.keys(f.counts).filter(id => /-author$/.test(id)), [`s${number}-author`]);
  }
});

test('工具不可用进入问题节点；中断重启后续跑保留原文件链接及已完成结果', async t => {
  const f = await fixture(t, '05-', ({ nodeId, count, output }) => nodeId === 's5-author' && count === 1
    ? { ...output, state: 'clarify', questions: ['请提供可用的浏览器测试环境和登录权限'] } : output);
  const waiting = await drive(f.engine, f.id);
  assert.equal(waiting.pending.nodeId, 's5-author-questions');
  assert.equal(f.counts['s5-review-testing'], undefined);
  assert.match(f.calls[0].request.prompt, /https:\/\/example.invalid\/private\/requirements/);
  await f.engine.interrupt(f.id);
  const restarted = f.create();
  t.after(() => restarted.stop('test'));
  await restarted.restore(f.workflow.id);
  const resumed = await restarted.continue(f.id);
  const batch = resumed.pending.interaction;
  await restarted.answer(f.id, { batchId: batch.id, questionId: batch.questions[0].id, text: '测试环境已就绪' });
  assert.equal((await drive(restarted, f.id)).status, 'succeeded');
  assert.equal(f.counts.preflight, 1);
  assert.match(f.calls.find(call => call.nodeId === 's5-author' && call.count === 2).request.prompt, /测试环境已就绪/);
  assert.equal(restarted.active.get(f.id).outputs.materials.file.url, 'https://example.invalid/private/requirements');
});

test('测试修复持续有进展仍在第五轮硬暂停，不能追加第六轮', async t => {
  const f = await fixture(t, '08-', ({ nodeId, count }) => {
    if (nodeId === 's5-review-testing') { return review(80, ['DEF-1 未修复']); }
    if (nodeId === 's5-decision') {
      return { ...decision('revise'), resolvedIssueIds: Array.from({ length: count - 1 }, (_, i) => `CLOSED-${i}`) };
    }
    return undefined;
  });
  const waiting = await drive(f.engine, f.id);
  assert.equal(waiting.pending.kind, 'loop');
  assert.equal(waiting.pending.nodeId, 's5-loop');
  assert.equal(waiting.pending.reason, 'total-limit');
  assert.equal(waiting.pending.canContinue, false);
  assert.equal(f.counts['s5-author'], 5);
  assert.equal(f.counts['s6-author'], 5);
  await assert.rejects(f.engine.decideLoop(f.id, 'continue'), { code: 'LOOP_TOTAL_LIMIT' });
  assert.equal(f.counts['s5-author'], 5);
  await f.engine.decideLoop(f.id, 'exit');
  assert.match(outputs(f).end.final, /status=unfinished/);
});

test('上轮问题必须回到作者修改，再向全部角色传递位置与校验证据，第五轮通过正常交接', async t => {
  const resolution = { issueId: 'ISSUE-1', changeLocation: '需求分析/边界规则', verification: '逐条对照原需求 REQ-1',
    evidence: '正文边界规则第2段与原文第3段一致', status: 'verified' };
  const f = await fixture(t, '01-', ({ nodeId, count, output }) => {
    if (nodeId === 's1-author' && count > 1) { return { ...output, resolutions: [resolution] }; }
    if (nodeId.includes('-review-')) {
      const result = review(count < 5 ? 80 : 100, count < 5 ? ['ISSUE-1 尚有遗漏'] : []);
      result.checks[0].resolutions = [{ ...resolution, resolved: count === 5 }];
      return result;
    }
    if (nodeId === 's1-decision') {
      return { ...decision(count < 5 ? 'revise' : 'aligned'), issues: count < 5 ? ['ISSUE-1 尚有遗漏'] : [],
        resolvedIssueIds: count === 5 ? ['ISSUE-1'] : [] };
    }
    return undefined;
  });
  let run = await drive(f.engine, f.id);
  assert.equal(run.pending.reason, 'no-progress');
  assert.equal(f.counts['s1-author'], 3);
  await f.engine.decideLoop(f.id, 'continue');
  run = await drive(f.engine, f.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(f.counts['s1-author'], 5);
  const second = f.calls.find(call => call.nodeId === 's1-author' && call.count === 2);
  assert.match(second.request.prompt, /ISSUE-1 尚有遗漏/);
  for (const role of ['product', 'development', 'testing']) {
    const reviewCall = f.calls.find(call => call.nodeId === `s1-review-${role}` && call.count === 2);
    assert.ok(f.calls.indexOf(second) < f.calls.indexOf(reviewCall));
    assert.ok(reviewCall.request.prompt.includes(resolution.changeLocation));
    assert.ok(reviewCall.request.prompt.includes(resolution.evidence));
    assert.match(reviewCall.request.prompt, /上轮协调结论/);
  }
  const saved = JSON.parse(await readFile(join(f.outputDirectory, 'audit/01-需求分析文档-author.json'), 'utf8'));
  assert.deepEqual(saved.resolutions, [resolution]);
  assert.match(outputs(f).end.final, /status=aligned/);
});

test('启动资料缺失保留用户回答后重新核对，不提前执行作者', async t => {
  const f = await fixture(t, '03-', ({ nodeId, count, output }) => nodeId === 'preflight' && count === 1
    ? { ...output, state: 'clarify', questions: ['项目目录在哪里？'] } : output);
  assert.equal((await drive(f.engine, f.id)).pending.nodeId, 'preflight-questions');
  assert.equal(f.counts['s3-author'], undefined);
  await f.submit('采用本次配置中的目录');
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  assert.equal(f.counts.preflight, 2);
  assert.match(f.calls.find(call => call.nodeId === 'preflight' && call.count === 2).request.prompt, /采用本次配置中的目录/);
});

test('高分带未决问题也被硬路由拦住，协调Agent误报不能放行', async t => {
  const f = await fixture(t, '01-', ({ nodeId, count }) => nodeId === 's1-review-development' && count === 1
    ? review(100, [], ['未决业务问题']) : undefined);
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  assert.equal(f.counts['s1-author'], 2);
});

test('评审JSON不符合字段契约时停止当前节点，不生成成功产物', async t => {
  const f = await fixture(t, '01-', ({ nodeId }) => nodeId === 's1-review-product' ? { score: 100 } : undefined);
  for (let i = 0; i < 3; i += 1) { await f.engine.resume(f.id); }
  const run = f.engine.get(f.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'AGENT_OUTPUT_INVALID');
  assert.equal(outputs(f)['s1-passed'], undefined);
});

test('测试阶段用户答复传给本轮修复Agent，而不是等到下次测试才可见', async t => {
  const f = await fixture(t, '08-', ({ nodeId, count }) => {
    if (nodeId === 's5-review-testing' && count === 1) { return review(80, [], ['DEF-1 以哪个业务规则修复？']); }
    if (nodeId === 's5-decision' && count === 1) { return { ...decision('clarify'), questions: ['DEF-1 以哪个业务规则修复？'] }; }
    return undefined;
  });
  assert.equal((await drive(f.engine, f.id)).pending.nodeId, 's5-review-questions');
  await f.submit('采用用户确认的规则 B');
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  assert.match(f.calls.find(call => call.nodeId === 's6-author').request.prompt, /采用用户确认的规则 B/);
});

test('跨阶段传递作者累积的用户决定，而不只依赖正文重复记载', async t => {
  const f = await fixture(t, '00-', ({ nodeId, output }) => nodeId === 's1-author'
    ? { ...output, decisions: ['DECISION-ONLY-用户选择替补在本回合行动'] } : undefined);
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  for (const nodeId of ['s2-author', 's2-review-product', 's3-author', 's4-author', 's5-author', 's7-author']) {
    assert.ok(f.calls.find(call => call.nodeId === nodeId).request.prompt.includes('DECISION-ONLY'), nodeId);
  }
});

test('文档模板表达式在评审、下游作者和实际Markdown输出中原样保留', async t => {
  const literal = '原始模板 {{customer.name}}，包括引号 " 和反斜线 \\。';
  const f = await fixture(t, '00-', ({ nodeId, output }) => nodeId === 's1-author'
    ? { ...output, artifact: [literal] } : undefined);
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  for (const nodeId of ['s1-review-product', 's1-decision', 's2-author', 's2-review-product']) {
    assert.ok(f.calls.find(call => call.nodeId === nodeId).request.prompt.includes('{{customer.name}}'), nodeId);
  }
  const content = await readFile(join(f.outputDirectory, '01-需求分析文档.md'), 'utf8');
  assert.ok(content.includes(literal));
  const author = JSON.parse(await readFile(join(f.outputDirectory, 'audit/01-需求分析文档-author.json'), 'utf8'));
  assert.deepEqual(author.artifact, [literal]);
  assert.deepEqual(author.checklist, checklist);
  const reviews = JSON.parse(await readFile(join(f.outputDirectory, 'audit/01-需求分析文档-reviews.json'), 'utf8'));
  assert.deepEqual(Object.keys(reviews.results), ['s1-review-product', 's1-review-development', 's1-review-testing']);
  const coordinator = JSON.parse(await readFile(join(f.outputDirectory, 'audit/01-需求分析文档-decision.json'), 'utf8'));
  assert.equal(coordinator.route, 'aligned');
});

test('修复作者接收本轮全部测试评审和协调意见中的独有缺陷', async t => {
  const f = await fixture(t, '08-', ({ nodeId, count }) => {
    if (nodeId === 's5-review-testing' && count === 1) { return review(80, ['DEF-REVIEW-ONLY']); }
    if (nodeId === 's5-decision' && count === 1) { return { ...decision('revise'), issues: ['COORDINATOR-ONLY'] }; }
    return undefined;
  });
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  const prompt = f.calls.find(call => call.nodeId === 's6-author').request.prompt;
  assert.ok(prompt.includes('DEF-REVIEW-ONLY'));
  assert.ok(prompt.includes('COORDINATOR-ONLY'));
});

test('Markdown导出逐字保留段落和代码块内的空行', async t => {
  const literal = '# 标题\n\n第一段 {{customer.name}}\n\n第二段\n\n```txt\nline1\n\nline2\n```\n';
  const f = await fixture(t, '01-', ({ nodeId, output }) => nodeId === 's1-author'
    ? { ...output, artifact: [literal] } : undefined);
  assert.equal((await drive(f.engine, f.id)).status, 'succeeded');
  assert.equal(await readFile(join(f.outputDirectory, '01-需求分析文档.md'), 'utf8'), literal);
});
