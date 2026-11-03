import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

test('person selection and project refresh produce task details, while project counts and empty states remain explicit',
  { timeout: 60000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pingcode-query-flow-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
      args: [resolve('plugin-dev/pingcode/test/fixtures/ui.cjs'), `--test-data=${directory}`] });
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: '刷新项目列表', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '项目选项已更新' }).waitFor();
    assert.match(await frame.locator('tbody').innerText(), /搜索|选择人员/);
    await frame.getByLabel('时间口径', { exact: true }).selectOption('createdAt');
    assert.equal(await frame.locator('#date-heading').textContent(), '创建时间', 'empty-table heading must track date basis');
    await frame.getByLabel('人员名称', { exact: true }).fill('吴杰');
    await frame.getByRole('button', { name: '搜索人员', exact: true }).click();
    await frame.getByLabel('人员', { exact: true }).selectOption('two');
    await frame.locator('#total strong').waitFor();
    assert.equal(await frame.locator('tbody tr[data-task]').count(), 4);
    assert.equal(await frame.locator('#total strong').textContent(), '5.2');
    const initialQuery = await page.evaluate(() => fixture.calls.findLast(call => call.name === 'pingcode.start').args[0]);
    assert.match(initialQuery.month, /^\d{4}-\d{2}$/);
    assert.equal(initialQuery.dateField, 'createdAt');
    await frame.getByRole('button', { name: '刷新项目列表', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '任务查询完成' }).waitFor();
    assert.equal(await frame.locator('tbody tr[data-task]').count(), 4, 'refresh must reload task details');
    await frame.getByLabel('项目', { exact: true }).selectOption('');
    await frame.getByRole('status').filter({ hasText: '任务查询完成' }).waitFor();
    assert.equal(await page.evaluate(() => fixture.calls.findLast(call => call.name === 'pingcode.start').args[0].projectId), '');
    const previous = await page.evaluate(() => {
      const now=new Date();now.setDate(1);now.setMonth(now.getMonth()-1);
      return now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
    });
    await frame.getByLabel('月份', { exact: true }).fill(previous);
    await frame.getByLabel('时间口径', { exact: true }).selectOption('completedAt');
    await frame.locator('#total strong').waitFor();
    const monthQuery = await page.evaluate(() => fixture.calls.findLast(call => call.name === 'pingcode.start').args[0]);
    assert.equal(monthQuery.month, previous);
    assert.equal(monthQuery.dateField, 'completedAt');
    assert.equal(await frame.locator('tbody tr[data-task]').count(), 0);
    assert.match(await frame.locator('tbody').innerText(), /没有匹配任务/);
    await page.evaluate(() => { fixture.members = [{ id: 'one', name: '吴杰', username: 'wujie' }]; });
    await frame.getByLabel('月份', { exact: true }).fill('');
    await frame.getByRole('button', { name: '搜索人员', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '任务查询完成' }).waitFor();
    assert.equal(await frame.getByLabel('人员', { exact: true }).inputValue(), 'one');
    assert.equal(await frame.locator('tbody tr[data-task]').count(), 5);
    for (const [role, label] of [['developer', '开发负责人'], ['tester', '测试负责人']]) {
      await frame.getByLabel('角色', { exact: true }).selectOption(role);
      await frame.getByRole('status').filter({ hasText: '任务查询完成' }).waitFor();
      assert.equal(await frame.locator('#role-heading').textContent(), label);
      assert.equal(await page.evaluate(() => fixture.calls.findLast(call => call.name === 'pingcode.start').args[0].role), role);
    }
    await page.evaluate(() => { fixture.cancelTasks = true; });
    await frame.getByRole('button', { name: '查询任务', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '查询已取消' }).waitFor();
    assert.match(await frame.locator('tbody').innerText(), /查询已取消/);
    await page.evaluate(() => { fixture.cancelTasks = false; fixture.slow = true; fixture.progressPhase = 'details'; });
    await frame.getByRole('button', { name: '查询任务', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '正在读取任务详情' }).waitFor();
    await frame.getByRole('button', { name: '取消查询', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '查询已取消' }).waitFor();
  });
