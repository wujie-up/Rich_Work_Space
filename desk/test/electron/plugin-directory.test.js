import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from './helpers.js';
import { withPackageSource } from '../../src/main/common/plugin-package.js';

const packages = [
  ['ai-agent-sessions', '0.4.0', '#transcript', '关闭并归档会话，保留配置和历史。'],
  ['mcp-services', '0.4.0', '#services', '停止 MCP 服务，保留连接配置。'],
  ['text-editor', '0.1.3', '#editor', '关闭编辑器，保留已保存文件和草稿。'],
  ['work-flow', '0.2.0', '#palette button', '关闭编排界面，停止运行中的工作流，保留工作流定义、邮件账号和运行历史。']
];
const archive = (id, version) => resolve(`plugin-dev/dist/${id}-${version}.plg`);

test('all delivered archives import, open, uninstall with data retained and reinstall', { timeout: 180000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false, executablePath: process.env.WORK_DESK_TEST_EXECUTABLE });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [id, version, selector, closeDescription] of packages) {
    await mkdir(join(data, 'plugin-data', id), { recursive: true });
    await writeFile(join(data, 'plugin-data', id, 'preserve-test.json'), '{"history":"keep"}');
    await page.evaluate(async id => {
      if ((await workDesk.plugins.list()).some(plugin => plugin.id === id && plugin.state !== 'uninstalled')) {
        const preview = await workDesk.plugins.preview(id, 'remove');
        await workDesk.plugins.remove(id, 'keep', preview.confirmationToken);
      }
    }, id);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive(id, version));
    await page.evaluate(() => workDesk.plugins.install());
    const record = await page.evaluate(async id => (await workDesk.plugins.list()).find(plugin => plugin.id === id), id);
    assert.equal(record.version, version);
    assert.equal(record.state, 'enabled');
    assert.equal(await readFile(join(data, 'plugin-data', id, 'preserve-test.json'), 'utf8'), '{"history":"keep"}');
    await page.locator(`.shelf-app[data-plugin="${id}"]`).click();
    await page.frameLocator('iframe.plugin-view:visible').locator('body').waitFor();
    const frame = page.frames().find(frame => frame.url().startsWith(`desk-plugin://${id}/`));
    await frame.waitForLoadState('load');
    await frame.locator(selector).first().waitFor();
    assert.ok((await frame.locator('body').innerText()).trim().length > 10, `${id} rendered its UI`);
    // A rendered page can still be loading initial plugin data; close only after those RPCs settle.
    await page.waitForFunction(async id => {
      try {
        await workDesk.plugins.preview(id, 'disable');
        return true;
      } catch (error) {
        if (!error.message.includes('插件正在创建任务或执行操作')) {
          throw error;
        }
        return false;
      }
    }, id);
    // This verifies package lifecycle separately from native titlebar pointer hit testing.
    await page.getByRole('button', { name: '关闭窗口', exact: true }).last().evaluate(button => button.click());
    await page.getByRole('dialog').getByText(closeDescription, { exact: true }).waitFor().catch(async error => {
      throw new Error(`${id}: ${await page.getByRole('dialog').innerText()}`, { cause: error });
    });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.application-window').waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
});

test('startup discovers extracted archives and disables a tampered plugin without blocking siblings', { timeout: 120000 }, async t => {
  const { page } = await launch(t, { openPlugin: false, executablePath: process.env.WORK_DESK_TEST_EXECUTABLE,
    prepareData: async data => {
      await writeFile(join(data, 'plugins.json'), '[]');
      for (const [id, version] of packages) {
        const target = join(data, 'plugins', id);
        await mkdir(target, { recursive: true });
        await withPackageSource(archive(id, version), directory => cp(directory, target, { recursive: true }));
      }
      await writeFile(join(data, 'plugins/text-editor/dist/renderer/app.js'), 'throw Error("must not execute");');
    } });
  const records = await page.evaluate(() => workDesk.plugins.list());
  assert.equal(records.find(record => record.id === 'ai-agent-sessions').state, 'enabled');
  assert.equal(records.find(record => record.id === 'mcp-services').state, 'enabled');
  const damaged = records.find(record => record.id === 'text-editor');
  assert.equal(damaged.state, 'disabled');
  assert.equal(damaged.lastError.stage, 'integrity');
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  await page.frameLocator('iframe.plugin-view:visible').locator('body').waitFor();
  await assert.rejects(page.evaluate(() => workDesk.plugins.enable('text-editor')), /完整性/);
});
