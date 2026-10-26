import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packPackage } from '../../../../desk/src/main/common/plugin-package.js';
import { launch, openConfiguration } from '../../../../desk/test/electron/helpers.js';

// Simulate only model replies; installed plugins, capability mediation and the editor remain real.
async function provider(root) {
  const directory = join(root, 'provider');
  await mkdir(directory);
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id: 'pipeline-test-agent', name: '流水线测试 Agent', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: true, background: 'service', main: 'index.mjs' }));
  await writeFile(join(directory, 'index.mjs'), `
export function deactivate() {}
export async function activate(context) {
  const tasks = new Map();
  const calls = [];
  context.methods.register('probe.calls', () => calls);
  const start = input => {
    calls.push(input);
    tasks.set(input.taskKey, { state: 'running', requests: [{ id: 'approve', method: 'item/commandExecution/requestApproval', params: {} }] });
    return { state: 'running' };
  };
  for (const [id, handler] of [
    ['agent.task.start.v1', start],
    ['agent.menu.code.start.v1', start],
    ['agent.task.read.v1', input => tasks.get(input.taskKey)],
    ['agent.task.respond.v1', input => {
      if (input.decision !== 'accept') { throw Error('审批选择未透传'); }
      tasks.set(input.taskKey, { state: 'succeeded', output: '开始评审\\n' + JSON.stringify({ passed: false, summary: '需要修改' }) });
      return { accepted: true };
    }],
    ['agent.task.cancel.v1', input => { tasks.set(input.taskKey, { state: 'cancelled' }); return { state: 'cancelled' }; }]
  ]) {
    await context.capabilities.register({ id, version: 1, title: id, description: id, state: 'ready', effects: ['workspace.read'],
      confirmation: 'policy', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      execution: { timeoutMs: 30000, cancellable: true, retry: 'never' } }, handler);
  }
}
`);
  const archive = join(root, 'provider.plg');
  await packPackage(directory, archive);
  return archive;
}

async function install(app, page, archive, id) {
  await page.evaluate(async id => {
    const existing = (await workDesk.plugins.list()).find(item => item.id === id);
    if (existing && existing.state !== 'uninstalled') {
      const preview = await workDesk.plugins.preview(id, 'remove');
      await workDesk.plugins.remove(id, 'keep', preview.confirmationToken);
    }
  }, id);
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive);
  await page.evaluate(() => workDesk.plugins.install());
  const record = await page.evaluate(async id => (await workDesk.plugins.list()).find(item => item.id === id), id);
  if (record.state !== 'enabled') {
    await page.evaluate(id => workDesk.plugins.enable(id), id);
  }
  return record;
}

test('最新 DeckPg：角色输入输出保存、分支编辑、原生审批和循环决定，普通/平铺/配置页可用', { timeout: 150000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = await provider(root);
  const { app, page, logs } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  t.after(() => writeFile(join(output, 'pipeline.log'), logs.join('')));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const existingAgent = await install(app, page, resolve('plugin-dev/dist/ai-agent-sessions-0.6.1.plg'), 'ai-agent-sessions');
  assert.equal(existingAgent.version, '0.6.1');
  const manifest = JSON.parse(await readFile(resolve('plugin-dev/work-flow/plugin.json'), 'utf8'));
  const installed = await install(app, page, resolve(`plugin-dev/dist/${manifest.id}-${manifest.version}.plg`), manifest.id);
  assert.equal(installed.version, manifest.version);
  await install(app, page, archive, 'pipeline-test-agent');
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const node = (id, type, x, y, params = {}) => ({ id, title: id, type, x, y, params });
  const workflow = await invoke('workflows.save', { name: '产品开发测试循环', nodes: [
    node('source', 'text.input', 20, 20, { content: '新增菜单功能' }),
    node('review', 'agent.review', 280, 20, { providerId: 'pipeline-test-agent', mode: 'code', cwd: root, files: 'source.js', rolePrompt: '你是产品评审 Agent',
      inputMapping: '{"requirement":"{{source.text}}","previous":"{{loop.previous}}"}', outputFields: '{"passed":"boolean","summary":"string"}' }),
    node('round', 'flow.loop', 280, 220, { input: '{{review.output.passed}}', expected: 'false', maxIterations: 1 }),
    node('done', 'flow.end', 20, 220, { input: '{{review.output.summary}}' })], edges: [
    { from: 'source', to: 'review' }, { from: 'review', to: 'round' },
    { from: 'round', to: 'review', branch: 'continue' }, { from: 'round', to: 'done', branch: 'exit' }
  ] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  let frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('[data-node="review"]').click();
  assert.equal(await frame.locator('[data-param="rolePrompt"]').inputValue(), '你是产品评审 Agent');
  await frame.locator('[data-param="rolePrompt"]').fill('你是产品验收 Agent');
  await frame.locator('[data-edge="round>done"]').dispatchEvent('click');
  assert.equal(await frame.locator('#edge-branch').inputValue(), 'exit');
  await frame.locator('#edge-branch').fill('exit');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).nodes[1].params.rolePrompt, '你是产品验收 Agent');
  await page.screenshot({ path: join(output, 'pipeline-window.png') });
  await page.getByRole('button', { name: '平铺到桌面', exact: true }).click();
  await frame.locator('#run').click();
  await frame.locator('[data-approval="0"][data-decision="accept"]').waitFor({ timeout: 30000 });
  await frame.locator('[data-approval="0"][data-decision="accept"]').click();
  await frame.locator('[data-loop="continue"]').waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(output, 'pipeline-tiled.png') });
  await frame.locator('[data-loop="continue"]').click();
  await frame.locator('[data-approval="0"][data-decision="accept"]').waitFor({ timeout: 30000 });
  await frame.locator('[data-approval="0"][data-decision="accept"]').click();
  await frame.locator('[data-loop="exit"]').waitFor({ timeout: 30000 });
  await frame.locator('[data-loop="exit"]').click();
  await frame.locator('#status').filter({ hasText: '运行完成' }).waitFor();
  const run = (await invoke('runs.list', workflow.id)).at(-1);
  assert.equal(run.iterations.round, 2);
  assert.equal(run.nodes.done.output.final, '需要修改');
  const calls = await page.evaluate(() => workDesk.plugins.invoke('pipeline-test-agent', 'probe.calls', []));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].taskKey, calls[1].taskKey);
  assert.match(calls[1].prompt, /"passed":false/);
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  const settings = page.locator('dialog.plugin-settings');
  await settings.getByText(`v${manifest.version}`, { exact: false }).waitFor();
  await settings.screenshot({ path: join(output, 'pipeline-settings.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.deepEqual(errors, []);
});
