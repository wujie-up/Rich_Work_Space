import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packPackage } from '../../../../desk/src/main/common/plugin-package.js';
import { launch } from '../../../../desk/test/electron/helpers.js';

// Only the model boundary is simulated; workflow UI and host capability routing remain real.
async function provider(root) {
  const source = join(root, 'provider');
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'workflow-test-agent', name: '测试 Agent', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: true, background: 'service', main: 'index.mjs' }));
  await writeFile(join(source, 'index.mjs'), `
export async function deactivate() {}
export async function activate(context) {
  const tasks = new Map();
  const stats = { starts: 0, reads: 0, cancelled: 0 };
  context.methods.register('probe.stats', () => stats);
  for (const [id, handler] of [
    ['agent.task.start.v1', input => {
      stats.starts++;
      tasks.set(input.taskKey, { state: 'running', requests: [{ id: 'country', method: 'item/tool/requestUserInput',
        params: { questions: [{ id: 'country', question: '需要分析哪个国家？' }] } }] });
      return { state: 'running' };
    }],
    ['agent.task.read.v1', input => {
      stats.reads++;
      const task = tasks.get(input.taskKey);
      return task.readyAt && Date.now() >= task.readyAt ? { state: 'succeeded', output: '中国订单服务：连接池耗尽' } : task;
    }],
    ['agent.task.respond.v1', input => {
      if (input.answers.country !== '中国') { throw Error('回答未正确传递'); }
      tasks.set(input.taskKey, { state: 'running', requests: [], readyAt: Date.now() + 33000 });
      return { accepted: true };
    }],
    ['agent.task.cancel.v1', input => {
      stats.cancelled++;
      tasks.set(input.taskKey, { state: 'cancelled' });
      return { state: 'cancelled' };
    }]
  ]) {
    await context.capabilities.register({ id, version: 1, title: id, description: id, state: 'ready', effects: ['workspace.read'],
      confirmation: 'policy', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      execution: { timeoutMs: 30000, cancellable: true, retry: 'never' } }, handler);
  }
}
`);
  const archive = join(root, 'provider.plg');
  await packPackage(source, archive);
  return archive;
}

test('最新 DeckPg：分类配置保存恢复、真实 AI 提供方、跨 RPC 长任务问答与停止', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-workflow-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = await provider(root);
  const { app, page, logs } = await launch(t, { openPlugin: false });
  t.after(async () => {
    await mkdir(resolve('.test-results/work-flow'), { recursive: true });
    await writeFile(resolve('.test-results/work-flow/agent.log'), logs.join(''));
  });
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const installed = await page.evaluate(() => workDesk.plugins.list());
  for (const [id, file] of [['work-flow', 'work-flow'], ['ai-agent-sessions', 'ai-agent']]) {
    const manifest = JSON.parse(await readFile(resolve(`plugin-dev/${file}/plugin.json`), 'utf8'));
    assert.equal(installed.find(plugin => plugin.id === id).version, manifest.version);
  }
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  let frame = page.frameLocator('iframe.plugin-view:visible');
  await frame.locator('#new-workflow').click();
  await frame.locator('#workflow-name').fill('通用 Agent 协作');
  assert.doesNotMatch(await frame.locator('#notice').textContent(), /AI Agent/);
  await frame.locator('#add-node').click();
  await frame.locator('#properties [data-field="title"]').fill('订单告警');
  await frame.locator('#properties [data-param="content"]').fill('ERROR 数据库连接池耗尽');
  const sourceId = await frame.locator('.node', { hasText: '订单告警' }).getAttribute('data-node');
  await frame.locator('#node-category').selectOption('invoke');
  await frame.locator('#node-capability option[value="agent.review"]').waitFor({ state: 'attached' });
  await frame.locator('#add-node').click();
  await frame.locator('#properties [data-param="providerId"] option[value="ai-agent-sessions"]').waitFor({ state: 'attached' });
  await frame.locator('#properties [data-param="input"]').fill(`{{${sourceId}.text}}`);
  await frame.locator('.node', { hasText: '订单告警' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: 'Agent 任务' }).locator('.port.in').click();
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status').filter({ hasText: '运行失败' }).waitFor({ timeout: 30000 });
  assert.match(await frame.locator('#results').textContent(), /安装.*引擎|引擎.*安装/);
  assert.doesNotMatch(await frame.locator('#results').textContent(), /AGENT_PROVIDER_MISSING/);

  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive);
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(() => workDesk.plugins.enable('workflow-test-agent'));
  await frame.locator('#refresh-agents').click();
  await frame.locator('.node', { hasText: 'Agent 任务' }).click();
  await frame.locator('#properties [data-param="providerId"]').selectOption('workflow-test-agent');
  await frame.locator('#node-category').selectOption('process');
  await frame.locator('#node-capability').selectOption('result.collect');
  await frame.locator('#add-node').click();
  await frame.locator('.node', { hasText: 'Agent 任务' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.in').click();
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  const workflowId = (await invoke('workflows.list')).find(item => item.name === '通用 Agent 协作').id;
  await page.reload();
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  frame = page.frameLocator('iframe.plugin-view:visible');
  await frame.locator(`[data-workflow="${workflowId}"]`).click();
  await frame.locator('.node', { hasText: 'Agent 任务' }).click();
  assert.equal(await frame.locator('#properties [data-param="providerId"]').inputValue(), 'workflow-test-agent');
  assert.equal(await frame.locator('#properties [data-param="input"]').inputValue(), `{{${sourceId}.text}}`);
  await frame.locator('#run').click();
  await frame.locator('#request-plan-0').waitFor({ timeout: 30000 });
  await mkdir(resolve('.test-results/work-flow'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/work-flow/agent-question.png') });
  await frame.locator('#request-plan-0').fill('{"country":"中国"}');
  const answeredAt = Date.now();
  await frame.locator('[data-answer="0"]').click();
  await frame.locator('#status').filter({ hasText: '运行完成' }).waitFor({ timeout: 65000 });
  assert.ok(Date.now() - answeredAt >= 33000);
  assert.match(await frame.locator('#results').textContent(), /中国订单服务：连接池耗尽/);
  const stats = () => page.evaluate(() => workDesk.plugins.invoke('workflow-test-agent', 'probe.stats', []));
  assert.equal((await stats()).starts, 1);
  assert.ok((await stats()).reads > 2);
  await frame.locator('#run').click();
  await frame.locator('#request-plan-0').waitFor({ timeout: 30000 });
  await frame.locator('#cancel-run').click();
  await frame.locator('#status').filter({ hasText: '已停止' }).waitFor();
  assert.equal((await stats()).cancelled, 1);
  const runs = await invoke('runs.list', workflowId);
  assert.equal(runs.at(-1).status, 'canceled');
  assert.equal(Object.values(runs.at(-1).nodes).filter(node => node.status === 'skipped').length, 2);
  await frame.locator('#run').click();
  await frame.locator('#request-plan-0').waitFor({ timeout: 30000 });
  const preview = await page.evaluate(() => workDesk.plugins.preview('work-flow', 'disable'));
  await page.evaluate(token => workDesk.plugins.disable('work-flow', token), preview.confirmationToken);
  assert.equal((await stats()).cancelled, 2, '关闭工作流应取消所属任务，提供方仍可使用');
  assert.equal(await page.locator('.application-window').count(), 0);
});
