import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withPackageSource } from '../../../../desk/src/main/common/plugin-package.js';

test('真实桌面：启用定时、关闭重开恢复排期并补跑，界面不出现 find 报错', { timeout: 90000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'workflow-reopen-'));
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  const initialVersion = process.env.WORKFLOW_FROM_VERSION || manifest.version;
  let installed;
  await withPackageSource(resolve(`plugin-dev/dist/work-flow-${initialVersion}.plg`), async source => {
    installed = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
    await mkdir(join(data, 'plugins'), { recursive: true });
    await cp(source, join(data, 'plugins/work-flow'), { recursive: true });
  });
  await writeFile(join(data, 'plugins.json'), JSON.stringify([{ ...installed, state: 'enabled', autoStart: false }]));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    args: ['--desk-test', `--desk-data=${data}`], env, timeout: 30000 });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await page.frameLocator('iframe.plugin-view[src^="desk-plugin://work-flow/"]').locator('#list [data-workflow]').first().waitFor();
  const invoke = (method, ...args) => page.evaluate(({ method, args }) =>
    workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '定时恢复测试', nodes: [
    { id: 'start', type: 'flow.start', params: {} }, { id: 'end', type: 'flow.end', params: {} }],
  edges: [{ from: 'start', to: 'end' }], trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: true } });
  const close = () => page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('work-flow', 'close');
    await workDesk.plugins.close('work-flow', preview.confirmationToken);
  });
  // Reopen so the real frame reads the new definition through the actual IPC response path.
  if (initialVersion === manifest.version) {
    await close();
  } else {
    await page.evaluate(async archive => {
      const preview = await workDesk.plugins.preview('work-flow', 'upgrade');
      await workDesk.plugins.upgrade('work-flow', archive, preview.confirmationToken);
    }, resolve(`plugin-dev/dist/work-flow-${manifest.version}.plg`));
    errors.length = 0;
  }
  await page.locator('iframe.plugin-view[src^="desk-plugin://work-flow/"]').waitFor({ state: 'detached' });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view[src^="desk-plugin://work-flow/"]');
  const item = frame.locator(`[data-workflow="${workflow.id}"]`);
  await item.waitFor();
  assert.equal(await frame.locator('script[type="module"]').getAttribute('src'), `app.js?v=${manifest.version}`);
  await item.click();
  assert.equal(await item.locator('.workflow-schedule').count(), 1);
  await frame.locator('#run').click();
  await frame.locator('#status-text').filter({ hasText: '定时已关闭' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status-text').filter({ hasText: '定时已开启' }).waitFor();
  assert.equal((await invoke('runs.list', workflow.id)).length, 0);
  const rows = await invoke('triggers.next');
  assert.equal(Array.isArray(rows), true);
  assert.ok(rows.find(row => row.workflowId === workflow.id).nextAt > Date.now());
  await invoke('workflows.save', workflow);
  await frame.locator('#save').click();
  await frame.locator('#status-text').filter({ hasText: '已保存' }).waitFor();
  assert.doesNotMatch(await frame.locator('#status-text').innerText(), /find is not a function/);
  await close();
  await page.locator('iframe.plugin-view[src^="desk-plugin://work-flow/"]').waitFor({ state: 'detached' });
  const tablePath = join(data, 'plugin-data/work-flow/scheduled-tasks.json');
  const table = JSON.parse(await readFile(tablePath, 'utf8'));
  table.items.find(row => row.workflowId === workflow.id).nextAt = Date.now() - 1000;
  await writeFile(tablePath, JSON.stringify(table));
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await item.waitFor();
  const deadline = Date.now() + 10000;
  let row;
  do {
    row = (await invoke('triggers.next')).find(row => row.workflowId === workflow.id);
    if (row.lastStatus === 'succeeded' && row.nextAt > Date.now()) { break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(row.lastStatus, 'succeeded');
  assert.ok(row.nextAt > Date.now());
  assert.equal((await invoke('runs.list', workflow.id)).length, 1);
  assert.equal(await item.locator('.workflow-schedule').count(), 1);
  assert.doesNotMatch(await frame.locator('#status-text').innerText(), /find is not a function/);
  assert.deepEqual(errors, []);
  await close();
});
