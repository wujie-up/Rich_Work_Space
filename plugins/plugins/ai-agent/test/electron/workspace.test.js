import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, configure, create, output, owner, alive, openWorkspace, toggleTheme } from '../../../../../desk/test/electron/helpers.js';

test('workspace: stale plugin views preserve CLI configuration and the latest working directory', { timeout: 120000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  await configure(page);
  await page.evaluate(async (owner) => {
    const config = await agentDesk.storage.getAdapterConfig(owner);
    await agentDesk.storage.saveAdapterConfig(owner, { ...config, codex: { command: '/old/codex', args: [] }, marker: 'preserve' });
  }, owner);
  const icon = page.locator(`.shelf-app[data-plugin="${owner}"]`);
  const activate = async (index) => {
    if (await page.locator('#desktop').isVisible()) {
      await page.locator('#desktop').click();
    }
    await page.locator(`.session-bubble[data-window="${index + 1}"]`).click();
    await page.waitForFunction((id) => document.querySelector(`.application-window[data-window="${id}"]`).dataset.phase === 'open', String(index + 1));
    await page.locator(`.application-window[data-window="${index + 1}"] .window-title`).click();
  };
  await icon.click();
  const first = page.locator('iframe').nth(0).contentFrame();
  await first.locator('.workspace-tools').waitFor();
  await page.locator('#desktop').click();
  await icon.click();
  const second = page.locator('iframe').nth(1).contentFrame();
  await second.locator('.workspace-tools').waitFor();
  await activate(0);
  await first.getByRole('button', { name: '工作台操作', exact: true }).click();
  await first.getByRole('button', { name: 'CLI 配置', exact: true }).click();
  await first.getByLabel('可执行文件', { exact: true }).first().fill('/new/codex');
  await first.getByRole('button', { name: '保存配置', exact: true }).click();
  await first.locator('dialog').waitFor({ state: 'detached' });

  await activate(1);
  await second.getByRole('button', { name: '工作台操作', exact: true }).click();
  await second.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await second.locator('select[name="adapter"]').selectOption('custom');
  await second.locator('input[name="cwd"]').fill(resolve('desk'));
  await second.getByRole('button', { name: '启动会话', exact: true }).click();
  await second.locator('dialog').waitFor({ state: 'detached' });
  const config = await page.evaluate((owner) => agentDesk.storage.getAdapterConfig(owner), owner);
  assert.equal(config.codex.command, '/new/codex');
  assert.equal(config.lastCwd, resolve('desk'));
  assert.equal(config.marker, 'preserve');
  const { sessions } = await page.evaluate((owner) => agentDesk.sessions.list(owner), owner);
  assert.equal(sessions.length, 1);
  await output(page, sessions[0].id, 'READY 中文');
  await second.getByRole('button', { name: '工作台操作', exact: true }).click();
  await second.getByRole('button', { name: 'CLI 配置', exact: true }).click();
  assert.equal(await second.getByLabel('可执行文件', { exact: true }).first().inputValue(), '/new/codex');
  await second.getByRole('button', { name: '取消', exact: true }).click();

  await activate(0);
  await first.getByRole('button', { name: '工作台操作', exact: true }).click();
  await first.getByRole('button', { name: 'CLI 配置', exact: true }).click();
  await first.getByLabel('可执行文件', { exact: true }).first().fill('/newer/codex');
  await activate(1);
  await second.getByRole('button', { name: '工作台操作', exact: true }).click();
  await second.getByRole('button', { name: '新建会话', exact: true }).first().click();
  assert.equal(await second.locator('input[name="cwd"]').inputValue(), resolve('desk'));
  await second.locator('select[name="adapter"]').selectOption('custom');
  await second.locator('input[name="cwd"]').fill(resolve('plugins'));
  await second.getByRole('button', { name: '启动会话', exact: true }).click();
  await second.locator('dialog').waitFor({ state: 'detached' });
  await activate(0);
  await first.getByRole('button', { name: '保存配置', exact: true }).click();
  await first.locator('dialog').waitFor({ state: 'detached' });
  const latest = await page.evaluate((owner) => agentDesk.storage.getAdapterConfig(owner), owner);
  assert.equal(latest.codex.command, '/newer/codex');
  assert.equal(latest.lastCwd, resolve('plugins'));
  assert.equal(latest.marker, 'preserve');
  await first.getByRole('button', { name: '工作台操作', exact: true }).click();
  await first.getByRole('button', { name: '新建会话', exact: true }).first().click();
  assert.equal(await first.locator('input[name="cwd"]').inputValue(), resolve('plugins'));
  await first.getByRole('button', { name: '取消', exact: true }).click();
});

test('Codex permission selector shows native names and descriptions and saves the selected mode', async (t) => {
  const { page } = await launch(t);
  const view = page.frameLocator('iframe.plugin-view');
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner, { codex: { command, args } }),
    { owner, command: process.execPath, args: [resolve('desk/test/fixtures/pty-cli.cjs')] });
  await page.reload();
  await openWorkspace(page);
  await view.getByRole('button', { name: '工作台操作', exact: true }).click();
  await view.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const permission = view.locator('select[name="permission"]');
  assert.deepEqual(await permission.locator('option').allTextContents(), ['请求批准', '帮我批准', '完全访问权限']);
  assert.equal(await permission.inputValue(), 'request-approval');
  await view.getByText('编辑外部文件和使用互联网时始终询问', { exact: true }).waitFor();
  await permission.selectOption('approve-for-me');
  await view.getByText('仅对检测到的风险操作请求批准', { exact: true }).waitFor();
  await permission.selectOption('unrestricted');
  await view.getByText('可不受限制地访问互联网和你电脑上的任何文件', { exact: true }).waitFor();
  await view.locator('input[name="cwd"]').fill(resolve('.'));
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/codex-permissions.png') });
  await view.getByRole('button', { name: '启动会话', exact: true }).click();
  await view.locator('.session').waitFor();
  const { sessions } = await page.evaluate((owner) => agentDesk.sessions.list(owner), owner);
  assert.equal(sessions[0].permission, 'unrestricted');
  await output(page, sessions[0].id, 'READY 中文');
  const archived = await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: sessions[0].id });
  assert.equal(archived.permission, 'unrestricted');
  assert.equal(alive(sessions[0].pid), false);
});

test('workspace: 13 terminals, collapse, rename, drag, resize, themes, reload and history', { timeout: 180000 }, async (t) => {
  const { page } = await launch(t);
  const view = page.frameLocator('iframe.plugin-view');
  await configure(page);
  const sessions = [];
  for (let i = 0; i < 13; i++) { sessions.push(await create(page, `窗口 ${i + 1}`)); }
  await view.locator('.session:nth-child(13)').waitFor();
  const first = view.locator(`[data-session="${sessions[0].id}"]`);
  await first.getByRole('button', { name: '折叠', exact: true }).click();
  assert.match(await first.getAttribute('class'), /collapsed/);
  const before = await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id), { owner, id: sessions[0].id });
  await page.waitForTimeout(650);
  const after = await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id), { owner, id: sessions[0].id });
  assert.ok(after.sequence > before.sequence);
  await first.getByRole('button', { name: '改名', exact: true }).click();
  await view.locator('dialog input').fill('改名后的会话');
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await view.locator('.session-name').filter({ hasText: '改名后的会话' }).waitFor();
  await first.getByRole('button', { name: '展开', exact: true }).click();
  await view.locator('.session-header').nth(0).dragTo(view.locator('.session-header').nth(2));
  await first.evaluate((node) => { node.style.width = '600px'; node.style.height = '450px'; });
  await page.waitForTimeout(450);
  await toggleTheme(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/workspace-light-12.png') });
  await toggleTheme(page);
  await page.screenshot({ path: resolve('.test-results/workspace-dark-12.png') });
  const pids = sessions.map((s) => s.pid);
  await page.reload();
  await openWorkspace(page);
  await view.locator('.session:nth-child(13)').waitFor();
  const current = await page.evaluate((id) => agentDesk.sessions.list(id), owner);
  assert.deepEqual(current.sessions.map((s) => s.pid), pids);
  const layout = await page.evaluate((id) => agentDesk.storage.getLayout(id), owner);
  assert.equal(layout.sizes[sessions[0].id].height, 450);
  for (const session of sessions) {
    await output(page, session.id, 'READY 中文');
    await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
    assert.equal(alive(session.pid), false);
  }
  await view.getByRole('button', { name: '工作台操作', exact: true }).click();
  await view.getByRole('button', { name: '历史', exact: true }).click();
  await view.locator('.history-row:nth-child(13)').waitFor();
  await view.getByRole('button', { name: '回放', exact: true }).first().click();
  await view.locator('.replay-terminal .xterm').waitFor();
  assert.equal(await view.locator('.replay-terminal .xterm-helper-textarea').getAttribute('aria-label') !== null, true);
});

test('workspace: desktop resizing scales the complete plugin without reflow or replacing live terminals', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk') } : {}) });
  await configure(page);
  const session = await create(page, '等比例拉伸保留终端');
  await output(page, session.id, 'READY 中文');
  const frame = page.locator('iframe').contentFrame();
  const measure = () => frame.locator('body').evaluate((body) => {
    const heading = body.querySelector('.workspace-tools').getBoundingClientRect();
    const card = body.querySelector('.session').getBoundingClientRect();
    const canvas = body.querySelector('.xterm-screen').getBoundingClientRect();
    return { heading: { x: heading.x, y: heading.y, width: heading.width, height: heading.height },
      card: { x: card.x, y: card.y, width: card.width, height: card.height }, terminal: canvas.width,
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  await frame.locator('.xterm-screen').waitFor();
  const before = await measure();
  await frame.locator('.session').evaluate(node => { node.dataset.retained = 'same'; });
  const resize = page.getByRole('button', { name: '调整窗口大小', exact: true });
  await resize.focus();
  for (let index = 0; index < 8; index++) { await page.keyboard.press('ArrowLeft'); }
  for (let index = 0; index < 4; index++) { await page.keyboard.press('ArrowUp'); }
  await page.waitForTimeout(200);
  const after = await measure();
  const scale = Math.min(after.width / before.width, after.height / before.height);
  for (const name of ['heading', 'card']) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(after[name][key] - before[name][key] * scale) < 2, `${name}.${key} must scale uniformly`);
    }
  }
  assert.ok(Math.abs(after.terminal - before.terminal * scale) < 2);
  assert.equal(after.overflow, false);
  assert.equal(await frame.locator('.session').getAttribute('data-retained'), 'same');
  assert.equal((await page.evaluate(owner => agentDesk.sessions.list(owner), owner)).sessions[0].pid, session.pid);
  await frame.getByRole('button', { name: '工作台操作', exact: true }).click();
  await frame.getByRole('button', { name: 'CLI 配置', exact: true }).click();
  await frame.getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('.session').evaluate(node => { node.style.height = '1600px'; });
  const scroll = await frame.locator('body').evaluate(body => {
    body.scrollTop = body.scrollHeight;
    return body.scrollTop;
  });
  assert.ok(scroll > 0, 'long plugin content must remain scrollable after scaling');
});
