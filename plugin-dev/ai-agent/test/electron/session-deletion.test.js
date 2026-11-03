import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, configure, output, owner } from '../../../../desk/test/electron/helpers.js';

test('packaged close dialog archives or requires a second confirmation before deletion', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('plugin-dev/dist/ai-agent-sessions-0.6.29.plg'));
  await page.evaluate(() => workDesk.plugins.install());
  await configure(page);
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  const view = page.locator('iframe[title="AI Agent 会话"]').contentFrame();
  await view.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await view.locator('select[name="adapter"]').selectOption('custom');
  await view.locator('input[name="sessionName"]').fill('关闭选项验证');
  await view.locator('input[name="cwd"]').fill(data);
  await view.getByRole('button', { name: '启动会话', exact: true }).click();
  const card = view.locator('.session').first();
  await card.waitFor();
  const state = () => page.evaluate(owner => agentDesk.sessions.list(owner), owner);
  const session = (await state()).sessions[0];
  await output(page, session.id, 'READY');
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await mkdir('.test-results', { recursive: true });
  await view.locator('html').evaluate(node => { node.dataset.theme = 'dark'; });
  await page.screenshot({ path: resolve('.test-results/session-close-dark.png') });
  await view.locator('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await view.locator('dialog').getByText('确认永久删除？', { exact: true }).waitFor();
  assert.equal((await state()).sessions[0].exited, false, 'first delete choice must not stop the session');
  await view.locator('html').evaluate(node => { node.dataset.theme = 'light'; });
  await page.screenshot({ path: resolve('.test-results/session-delete-light.png') });
  await view.locator('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await state()).sessions.length, 1);
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await view.locator('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await view.locator('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await view.getByText('此引擎不支持彻底删除，请选择归档；不会仅删除本地回放', { exact: true }).waitFor();
  assert.equal((await state()).sessions[0].exited, false, 'unsupported engine must preserve live session');
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await view.locator('dialog').getByRole('button', { name: '归档', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  const after = await state();
  assert.equal(after.sessions.length, 0);
  assert.equal(after.archives.length, 1);
  assert.match((await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id),
    { owner, id: session.id })).output, /READY/);
});
