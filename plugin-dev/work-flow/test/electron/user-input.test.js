import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { launch, openConfiguration, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('最新 DeskPG：用户输入弹窗中断、重启续跑、确认继续和停止，标签工作区、窄窗口和配置页可用', { timeout: 120000 }, async t => {
  const { app, page, logs } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  t.after(() => writeFile(`${output}/user-input.log`, logs.join('')));
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  // The latest installation already includes this plugin; verify the packaged version instead of installing twice.
  const installed = await page.evaluate(() => workDesk.plugins.list());
  assert.equal(installed.find(plugin => plugin.id === 'work-flow')?.version, manifest.version);
  await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const types = await invoke('nodes.types');
  assert.ok(types.some(type => type.type === 'flow.user-input'), '已安装版本应提供用户介入节点');
  assert.ok(types.find(type => type.type === 'flow.user-input').params.some(param => param.name === 'interaction'),
    '用户介入应允许选择文件、文本和单选交互');
  const node = (id, type, params, x) => ({ id, type, params, title: id, x, y: 30 });
  const workflow = await invoke('workflows.save', { name: '用户介入验证', nodes: [
    node('source', 'text.input', { content: '<script>原文问题</script>\n["请提供项目目录","请确认对战方式"]' }, 20),
    node('human', 'flow.user-input', { title: '补充需求', prompt: '{{source.text}}', initialValue: '' }, 270),
    node('done', 'flow.end', { input: '{{human.text}}' }, 520)
  ], edges: [{ from: 'source', to: 'human' }, { from: 'human', to: 'done' }] });
  const fileWorkflow = await invoke('workflows.save', { name: '软件开发全流程 · 多 Agent 协作模板 · 超长工作流名称验证', nodes: [
    node('start', 'flow.start', {}, 20),
    node('document', 'flow.user-input', { interaction: 'file', title: '选择需求文档' }, 270),
    node('choice', 'flow.user-input', { interaction: 'choice', prompt: '{{document.text}}', options: '开始开发\n补充需求' }, 520),
    node('done', 'flow.end', { input: '{{choice.text}}' }, 770)
  ], edges: [{ from: 'start', to: 'document' }, { from: 'document', to: 'choice' }, { from: 'choice', to: 'done' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#run').click();
  const dialog = frame.locator('dialog[aria-labelledby="user-input-title"]');
  const popup = page.locator('dialog[data-plugin-message]');
  await popup.waitFor({ state: 'visible' });
  assert.match(await popup.innerText(), /<script>原文问题<\/script>/);
  assert.match(await popup.innerText(), /请提供项目目录/);
  assert.doesNotMatch(await popup.innerText(), /请确认对战方式/);
  const run = (await invoke('runs.list', workflow.id)).at(-1);
  assert.equal(run.status, 'waiting');
  await popup.locator('textarea').fill('项目目录：/tmp/demo');
  await popup.getByRole('button', { name: '确认', exact: true }).click();
  await popup.getByText('请确认对战方式', { exact: false }).waitFor();
  // Keep the dialog open beyond the former 30-second redisplay delay; waiting alone must never interrupt a run.
  await setTimeout(31000);
  assert.equal((await invoke('runs.get', run.id)).status, 'waiting');
  assert.equal(await popup.isVisible(), true);
  await popup.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  await frame.locator('#continue-run').waitFor({ state: 'visible' });
  assert.equal((await invoke('runs.get', run.id)).status, 'interrupted');
  assert.equal((await invoke('runs.get', run.id)).nodes.done, undefined);
  // A fresh plugin process must restore the same question without reopening it automatically.
  const preview = await page.evaluate(() => workDesk.plugins.preview('work-flow', 'disable'));
  await page.evaluate(token => workDesk.plugins.disable('work-flow', token), preview.confirmationToken);
  await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  assert.equal((await invoke('runs.get', run.id)).status, 'interrupted');
  assert.equal(await popup.isVisible(), false);
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#continue-run').click();
  await popup.getByText('请确认对战方式', { exact: false }).waitFor();
  assert.doesNotMatch(await popup.innerText(), /请提供项目目录/);
  await page.screenshot({ path: `${output}/user-input-window.png` });
  const progress = await invoke('runs.get', run.id);
  assert.equal(progress.pending.interaction.currentIndex, 1);
  await popup.locator('textarea').fill('回合制，不提交代码');
  await popup.getByRole('button', { name: '确认', exact: true }).click();
  await popup.waitFor({ state: 'hidden' });
  // Poll the backend outside the renderer; host questions can finish while the view is closed.
  let done = await invoke('runs.get', run.id);
  for (let attempt = 0; done.status === 'waiting' && attempt < 100; attempt += 1) {
    await setTimeout(200);
    done = await invoke('runs.get', run.id);
  }
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await frame.locator('#workflow-name').evaluate(element => element.value).then(name => assert.equal(name, workflow.name));
  assert.equal(done.id, run.id);
  assert.ok(done.nodes.done, JSON.stringify(done));
  assert.match(done.nodes.done.output.final, /项目目录：\/tmp\/demo/);
  assert.match(done.nodes.done.output.final, /回合制，不提交代码/);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await frame.locator('#run').click();
  await popup.waitFor({ state: 'visible' });
  const canceled = (await invoke('runs.list', workflow.id)).at(-1);
  await invoke('runs.cancel', canceled.id);
  await popup.waitFor({ state: 'hidden' });
  assert.equal((await invoke('runs.get', canceled.id)).status, 'canceled');
  await frame.locator(`[data-workflow="${fileWorkflow.id}"]`).click();
  const item = frame.locator(`[data-workflow="${fileWorkflow.id}"]`);
  assert.equal(await item.getAttribute('title'), fileWorkflow.name);
  assert.equal(await item.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
  await frame.locator('#toggle-list').click();
  assert.equal(await frame.locator('.layout').getAttribute('data-list-collapsed'), 'true');
  await frame.locator('#toggle-list').click();
  const divider = await frame.locator('#toggle-list').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(divider.x + 80, divider.y + divider.height / 2);
  await page.mouse.up();
  assert.ok((await frame.locator('#list').boundingBox()).width > 240);
  await frame.locator('[data-node="document"] .title').click();
  await frame.locator('#properties [data-field="title"]').fill('需求文档入口');
  assert.equal(await frame.locator('#workflow-properties').isVisible(), false);
  await frame.locator('#stage-wrap').click({ position: { x: 10, y: 350 } });
  assert.equal(await frame.locator('#workflow-properties').isVisible(), true);
  await frame.locator('#run').click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('input[type="file"]').setInputFiles({ name: '需求.md', mimeType: 'text/markdown',
    buffer: Buffer.from('项目目录：/tmp/demo\n需求：实现测试功能') });
  await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await frame.locator('#continue-run').click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('input[type="file"]').setInputFiles({ name: '需求.md', mimeType: 'text/markdown',
    buffer: Buffer.from('项目目录：/tmp/demo\n需求：实现测试功能') });
  assert.match(await dialog.locator('[data-file-name]').innerText(), /需求.md/);
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await popup.getByRole('button', { name: '开始开发', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/user-input-choice.png` });
  await popup.getByRole('button', { name: '开始开发', exact: true }).click();
  await popup.waitFor({ state: 'hidden' });
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  const fileDone = await invoke('runs.get', (await invoke('runs.list', fileWorkflow.id)).at(-1).id);
  assert.equal(fileDone.nodes.document.output.text, '项目目录：/tmp/demo\n需求：实现测试功能');
  assert.equal(fileDone.nodes.done.output.final, '开始开发');
  for (let index = 0; index < 2; index += 1) {
    await page.locator('#desktop').click();
    await toggleTheme(page);
    await page.locator('.shelf-app[data-plugin="work-flow"]').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
    await frame.locator('#run').click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('.file-source select').evaluate(input => document.activeElement === input), true);
    const bounds = await dialog.boundingBox();
    const viewportWidth = await page.evaluate(() => innerWidth);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewportWidth, JSON.stringify(bounds));
    const theme = await page.locator('html').getAttribute('data-theme');
    await page.screenshot({ path: `${output}/user-input-narrow-${theme}.png` });
    await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await frame.locator('#continue-run').waitFor({ state: 'visible' });
  }
  await page.locator('#desktop').click();
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  await page.locator('dialog.plugin-settings').getByText(`v${manifest.version}`, { exact: false }).waitFor();
  await page.locator('dialog.plugin-settings').screenshot({ path: `${output}/user-input-settings.png` });
  assert.deepEqual(errors, []);
});
