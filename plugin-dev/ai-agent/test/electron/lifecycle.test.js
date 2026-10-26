import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, configure, create, output, owner, alive, openConfiguration } from '../../../../desk/test/electron/helpers.js';

test('lifecycle: cancel, stale preview, owner-only stop, keep reinstall and isolated clear', { timeout: 120000 }, async (t) => {
  const { app, page, data } = await launch(t);
  const other = 'second-agent';
  const source = join(data, '可信插件 中文');
  await cp(resolve('plugin-dev/ai-agent'), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, id: other, name: '第二个插件' }));
  const select = (directory) => app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await select(source);
  await page.evaluate(() => workDesk.plugins.install());
  await configure(page, { child: true });
  await page.evaluate(({ id, command, args }) => agentDesk.storage.saveAdapterConfig(id, { custom: { command, args } }),
    { id: other, command: process.execPath, args: [resolve('desk/test/fixtures/pty-cli.cjs')] });
  const first = await create(page, '目标 · 折叠');
  const firstOutput = await output(page, first.id, /CHILD=\d+\r?\n/);
  const child = Number(firstOutput.data.match(/CHILD=(\d+)/)[1]);
  const unrelated = await create(page, '其他插件保持运行', other);
  await output(page, unrelated.id, 'READY 中文', other);
  await page.frameLocator('iframe').locator(`[data-session="${first.id}"]`).getByRole('button', { name: '折叠', exact: true }).click();
  await page.waitForTimeout(250);
  await openConfiguration(page);
  const target = page.locator(`[data-plugin="${owner}"].plugin-card`);
  await target.getByRole('switch', { name: '禁用', exact: true }).click();
  await page.waitForSelector('dialog .confirm-session');
  assert.match(await page.locator('dialog').innerText(), /目标 · 折叠 · 已折叠/);
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/plugin-disable-collapsed.png') });
  await page.locator('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(alive(first.pid) && alive(child) && alive(unrelated.pid), true);
  const stale = await page.evaluate((id) => workDesk.plugins.preview(id, 'disable'), owner);
  const added = await create(page, '预览后新增');
  await output(page, added.id, 'READY 中文');
  await assert.rejects(page.evaluate(({ owner, token }) => workDesk.plugins.disable(owner, token),
    { owner, token: stale.confirmationToken }), /任务列表已变化/);
  assert.equal(alive(first.pid) && alive(added.pid) && alive(unrelated.pid), true);
  await target.getByRole('switch', { name: '禁用', exact: true }).click();
  await page.locator('dialog').getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await target.getByRole('switch', { name: '启用', exact: true }).waitFor();
  for (const pid of [first.pid, child, added.pid]) {
    assert.equal(alive(pid), false);
  }
  assert.equal(alive(unrelated.pid), true);
  await target.getByRole('switch', { name: '启用', exact: true }).click();
  await target.getByRole('switch', { name: '禁用', exact: true }).waitFor();
  const retained = await page.evaluate((id) => agentDesk.sessions.list(id), owner);
  assert.equal(retained.sessions.length, 0);
  assert.equal(retained.archives.length, 2);
  await target.getByRole('button', { name: '卸载', exact: true }).click();
  assert.equal(await page.locator('dialog select').inputValue(), 'keep');
  await page.locator('dialog').getByRole('button', { name: '关闭并卸载', exact: true }).click();
  await target.getByText('已卸载', { exact: true }).waitFor();
  await select(resolve('plugin-dev/ai-agent'));
  await page.getByRole('button', { name: '＋ 导入本地插件', exact: true }).click();
  await target.getByRole('switch', { name: '禁用', exact: true }).waitFor();
  assert.deepEqual((await page.evaluate((id) => agentDesk.sessions.list(id), owner)).archives.map((s) => s.id),
    retained.archives.map((s) => s.id));
  const markers = [join(source, '模拟凭据'), join(data, '工作目录 文件')];
  for (const path of markers) {
    await writeFile(path, '必须逐字节保持 中文');
  }
  await page.evaluate(({ id }) => agentDesk.storage.saveAdapterConfig(id, { marker: 'other owner' }), { id: other });
  const before = await readFile(join(data, `plugin-data/${other}/config.json`));
  const third = await create(page, '清理目标');
  await output(page, third.id, 'READY 中文');
  await target.getByRole('button', { name: '卸载', exact: true }).click();
  await page.locator('dialog select').selectOption('clear');
  await page.locator('dialog').getByRole('button', { name: '关闭并卸载', exact: true }).click();
  await target.getByText('已卸载', { exact: true }).waitFor();
  assert.equal(alive(third.pid), false);
  assert.equal(alive(unrelated.pid), true);
  assert.deepEqual(await readFile(join(data, `plugin-data/${other}/config.json`)), before);
  for (const path of markers) {
    assert.equal(await readFile(path, 'utf8'), '必须逐字节保持 中文');
  }
  await assert.rejects(readFile(join(data, `plugin-data/${owner}/config.json`)), { code: 'ENOENT' });
  await page.screenshot({ path: resolve('.test-results/plugin-center.png') });
});
