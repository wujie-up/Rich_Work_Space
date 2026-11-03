import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner, alive } from '../../../../desk/test/electron/helpers.js';

test('packaged CLI failure retains its terminal and supports manual retry without affecting other sessions', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('plugin-dev/dist/ai-agent-sessions-0.6.12.plg'));
  await page.evaluate(() => workDesk.plugins.install());
  const fixture = join(data, 'network-failure.cjs');
  await writeFile(fixture, `const fs = require('node:fs');
const marker = __filename + '.started';
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'started');
  setTimeout(() => {
    console.error('Error: account/read failed during TUI bootstrap: workspace routing discovery failed (code -32603)');
    process.exit(1);
  }, 500);
} else {
  console.log('RETRY_READY');
  process.stdin.resume();
  process.stdin.on('data', data => console.log('INPUT=' + data.toString().trim()));
}
`);
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner, { custom: { command, args } }),
    { owner, command: process.execPath, args: [fixture] });
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  const view = page.locator('iframe[title="AI Agent 会话"]').contentFrame();
  await view.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await view.locator('select[name="adapter"]').selectOption('custom');
  await view.locator('input[name="sessionName"]').fill('网络失败保留窗口');
  await view.locator('input[name="cwd"]').fill(data);
  await view.getByRole('button', { name: '启动会话', exact: true }).click();
  const failed = view.locator('.session').first();
  await failed.locator('.session-error').filter({ hasText: 'Agent 异常退出' }).waitFor();
  const before = await page.evaluate(owner => agentDesk.sessions.list(owner), owner);
  assert.equal(before.sessions.length, 1);
  assert.equal(before.archives.length, 0);
  assert.equal(before.sessions[0].exited, true);
  assert.equal(alive(before.sessions[0].pid), false);
  await output(page, before.sessions[0].id, 'workspace routing discovery failed (code -32603)');
  const peer = await page.evaluate(({ owner, cwd, windowId }) => agentDesk.sessions.create(owner,
    { adapterId: 'custom', cwd, windowId, name: '互不影响' }), { owner, cwd: data, windowId: before.sessions[0].windowId });
  await output(page, peer.id, 'RETRY_READY');
  await mkdir('.test-results', { recursive: true });
  await page.screenshot({ path: resolve('.test-results/agent-abnormal-exit-retained.png') });
  await failed.getByRole('button', { name: '重试', exact: true }).click();
  await view.locator(`[data-session="${before.sessions[0].id}"]`).waitFor({ state: 'detached' });
  const after = await page.evaluate(owner => agentDesk.sessions.list(owner), owner);
  const replacement = after.sessions.find(record => record.restoredFrom === before.sessions[0].id);
  assert.ok(replacement);
  assert.equal(replacement.name, before.sessions[0].name);
  assert.equal(replacement.windowId, before.sessions[0].windowId);
  assert.equal(after.sessions.length, 2);
  await output(page, replacement.id, 'RETRY_READY');
  const replay = await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id), { owner, id: replacement.id });
  assert.match(replay.data, /account\/read failed/);
  assert.equal(replay.data.includes('INPUT='), false, 'diagnostic replay must never be sent to the new process');
  assert.equal(alive(peer.pid), true);
  assert.match((await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id),
    { owner, id: before.sessions[0].id })).output, /account\/read failed/);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'manual input\r'), { owner, id: replacement.id });
  await output(page, replacement.id, 'INPUT=manual input');
  const card = view.locator(`[data-session="${replacement.id}"]`);
  await card.getByRole('button', { name: '重试', exact: true }).waitFor({ state: 'hidden' });
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await view.locator('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(alive(peer.pid), true);
  const archived = await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id),
    { owner, id: before.sessions[0].id });
  assert.match(archived.output, /account\/read failed/);
  assert.match(archived.output, /INPUT=manual input/);
  await page.screenshot({ path: resolve('.test-results/agent-abnormal-exit-retried.png') });
  assert.equal((await page.evaluate(owner => workDesk.plugins.list(), owner)).find(plugin => plugin.id === owner).version, '0.6.12');
});
