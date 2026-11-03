import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('group sidebar creates members, retains terminals and presentation across navigation and reload', { timeout: 45000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-groups-ui-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import '@xterm/xterm/css/xterm.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/session-groups.css';
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    window.postMessage = () => {};
    const adapters = ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code',
      capabilities: { permissions: true, inputProtocol: id }, permissionModes: [
        { id: 'default', label: '请求批准' }, { id: 'unrestricted', label: '完全访问权限' }] }));
    let state = JSON.parse(localStorage.getItem('state')) || { groups: [], sessions: [
      { id: 'old', pluginId: 'one', name: '原有会话', adapterId: 'codex', cwd: '/project', activity: 'done', sequence: 0 } ], archives: [
      { id: 'history-backend', pluginId: 'one', name: '历史后端', adapterId: 'codex', cwd: '/project', closedAt: new Date().toISOString() },
      { id: 'history-review', pluginId: 'one', name: '历史评审', adapterId: 'claude', cwd: '/project', closedAt: new Date().toISOString() } ] };
    const listeners = new Set();
    const publish = () => { localStorage.setItem('state', JSON.stringify(state)); listeners.forEach(callback => callback(state)); };
    api.host.getWindowContext = async () => ({ id: 'host' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => JSON.parse(localStorage.getItem('layout')) || {};
    api.storage.saveLayout = async (id, layout) => localStorage.setItem('layout', JSON.stringify(layout));
    api.storage.getRoles = async () => ({});
    api.storage.getAdapterConfig = async () => ({ lastCwd: '/project' });
    api.sessions.recover = async () => ({ sessions: state.sessions, archives: [] });
    api.sessions.list = async () => state;
    api.sessions.attachWindow = async (owner, id, windowId) => { state.sessions.find(session => session.id === id).windowId = windowId; publish(); };
    api.sessions.attach = async () => ({ sequence: 0, data: '› Ask Codex to do anything\\r\\nGPT-6.1-sol · /project\\r\\n? for shortcuts' });
    api.sessions.resize = api.sessions.composer = async () => {};
    window.writes = [];
    api.sessions.write = async (pluginId, sessionId, data) => { window.writes.push({ pluginId, sessionId, data }); };
    api.sessions.restore = async (owner, id, windowId) => {
      const record = state.archives.find(session => session.id === id);
      const restored = { ...record, id: crypto.randomUUID(), restoredFrom: id, activity: 'done', sequence: 0, windowId };
      const group = state.groups.find(group => group.id === restored.groupId);
      if (group) { delete group.archivedAt; }
      state.sessions.push(restored); state.archives = state.archives.filter(session => session.id !== id);
      publish(); return restored;
    };
    api.events.output = () => () => {};
    api.events.sessionsChanged = callback => { listeners.add(callback); return () => listeners.delete(callback); };
    api.groups.create = async (owner, input) => {
      const group = { id: crypto.randomUUID(), name: input.name, collaboration: input.collaboration,
        ...(input.collaboration ? { coordinatorId: crypto.randomUUID() } : {}) }; state.groups.push(group);
      const sessions = input.members.map(member => ({ ...member, id: crypto.randomUUID(), pluginId: owner,
        windowId: input.windowId, cwd: member.cwd || input.cwd, groupId: group.id, activity: 'done', sequence: 0 }));
      if (input.collaboration) { sessions.push({ ...input.coordinator, id: group.coordinatorId, pluginId: owner, name: '组管理员', coordinator: true,
        windowId: input.windowId, cwd: input.coordinator.cwd || input.cwd, groupId: group.id, activity: 'done', sequence: 0 }); }
      state.sessions.push(...sessions); publish(); return { group, sessions, errors: [] };
    };
    api.groups.assign = async (owner, id, groupId) => {
      const record = [...state.sessions, ...state.archives].find(session => session.id === id);
      record.groupId = groupId; publish(); return record;
    };
    api.groups.rename = async (owner, id, name) => {
      const group = state.groups.find(group => group.id === id); group.name = name; publish(); return group;
    };
    api.groups.archive = async (owner, id) => {
      const members = state.sessions.filter(session => session.groupId === id);
      state.groups.find(group => group.id === id).archivedAt = new Date().toISOString();
      state.archives.push(...members.map(session => ({ ...session, reason: 'group-archived', closedAt: new Date().toISOString() })));
      state.sessions = state.sessions.filter(session => session.groupId !== id); publish();
    };
    api.groups.delete = async (owner, id) => {
      state.groups = state.groups.filter(group => group.id !== id);
      [...state.sessions, ...state.archives].filter(session => session.groupId === id).forEach(session => {
        delete session.groupId; delete session.coordinator; delete session.coordinating;
      });
      publish();
    };
    window.state = () => state;
    window.paint = () => publish();
    await mountWorkspace(document.querySelector('main'), { pluginId: 'one', adapters });
    window.ready = true;`, resolveDir: repository, sourcefile: 'session-groups-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><html data-theme="light"><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main id="workspace"></main><div id="toast" hidden></div><script type="module" src="app.js"></script></html>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.ready);
  await page.getByRole('navigation', { name: '会话组' }).waitFor({ timeout: 1500 });
  const sidebar = page.getByRole('navigation', { name: '会话组' });
  const separator = page.getByRole('separator', { name: '调整分组栏宽度' });
  await separator.waitFor({ timeout: 1500 });
  assert.equal(await page.locator('.group-member .session-status').getAttribute('data-kind'), 'waiting');
  assert.equal(await page.locator('.group-member .kettle-body').count(), 1);
  for (const [state, label] of [
    [{ activity: 'working' }, '运行中'], [{ activity: 'working', coordinating: true }, '运行中'], [{ activity: 'done', coordinating: true }, '空闲'],
    [{ activity: 'idle', blocked: true }, '等待确认'], [{ activity: 'error', exited: true }, '已退出'],
    [{ activity: 'starting' }, '连接中'], [{ activity: 'done' }, '空闲']
  ]) {
    await page.evaluate(state => {
      Object.assign(window.state().sessions[0], { coordinating: false, blocked: false, exited: false }, state);
      window.paint();
    }, state);
    await page.waitForFunction(label => document.querySelector('.group-member')?.title.endsWith(label), label);
    assert.equal(await sidebar.locator('.group-member small').count(), 0);
    assert.equal(await sidebar.locator('.group-member').innerText(), '原有会话');
    assert.ok((await sidebar.locator('.group-member').getAttribute('title')).endsWith(label));
    assert.equal(await sidebar.locator('.group-member .session-status svg').count(), 1);
  }
  const original = await sidebar.boundingBox();
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 80, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(width => document.querySelector('.session-groups').getBoundingClientRect().width >= width + 38, original.width);
  await separator.focus();
  const resized = (await sidebar.boundingBox()).width;
  await page.keyboard.press('ArrowRight');
  assert.ok((await sidebar.boundingBox()).width > resized);
  const savedWidth = (await sidebar.boundingBox()).width;
  const canvasWidth = (await page.locator('.group-canvas').boundingBox()).width;
  const toggleBox = await page.getByRole('button', { name: '隐藏分组栏', exact: true }).boundingBox();
  const headingBox = await page.locator('.page-heading').boundingBox();
  assert.ok(Math.abs(toggleBox.x - headingBox.x) < 2, 'sidebar toggle stays at the left of the toolbar');
  await page.getByRole('button', { name: '隐藏分组栏', exact: true }).click();
  assert.equal(await sidebar.isVisible(), false);
  const hiddenToggle = page.getByRole('button', { name: '显示分组栏', exact: true });
  assert.ok(Math.abs((await hiddenToggle.boundingBox()).x - toggleBox.x) < 2);
  assert.equal(await hiddenToggle.evaluate(node => node === document.activeElement), true);
  assert.ok((await page.locator('.group-canvas').boundingBox()).width > canvasWidth + 100);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await sidebar.isVisible(), false);
  await page.getByRole('button', { name: '显示分组栏', exact: true }).press('Enter');
  assert.ok(Math.abs((await sidebar.boundingBox()).width - savedWidth) < 2);
  await page.locator('[data-session="old"] .xterm-screen').evaluate(node => { node.dataset.retained = 'old'; });
  assert.equal(await sidebar.locator('.group-heading button').count(), 0);
  await page.getByRole('button', { name: '工作台操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '创建会话组', exact: true }).click();
  await page.locator('[name="groupName"]').fill('短剧开发');
  await page.locator('[name="memberCount"]').fill('2');
  await page.locator('[name="memberName0"]').fill('后端');
  await page.locator('[name="memberName1"]').fill('前端');
  for (const label of ['成员 1', '成员 2']) {
    assert.equal(await page.getByRole('combobox', { name: `${label} 权限模式`, exact: true }).inputValue(), 'unrestricted');
  }
  await page.getByRole('combobox', { name: '成员 2 权限模式', exact: true }).selectOption('default');
  await page.getByRole('combobox', { name: '成员 1 角色', exact: true }).selectOption('backend');
  await page.getByRole('combobox', { name: '成员 2 角色', exact: true }).selectOption('frontend');
  const mode = page.getByRole('switch', { name: '协作模式', exact: true });
  assert.equal(await mode.isChecked(), false);
  assert.equal(await page.getByRole('textbox', { name: '组管理员会话', exact: true }).isVisible(), false);
  await mode.check();
  assert.equal(await page.getByRole('textbox', { name: '组管理员会话', exact: true }).inputValue(), '组管理员');
  assert.equal(await page.getByRole('textbox', { name: '组管理员会话', exact: true }).getAttribute('readonly'), '');
  await page.getByRole('combobox', { name: '组管理员会话 引擎', exact: true }).selectOption('claude');
  assert.equal(await page.getByRole('combobox', { name: '组管理员会话 权限模式', exact: true }).inputValue(), 'unrestricted');
  await page.getByRole('textbox', { name: '成员 1 工作目录', exact: true }).fill('/project/backend');
  await page.getByRole('textbox', { name: '组管理员会话 工作目录', exact: true }).fill('/project/manager');
  const box = await page.locator('dialog.desk-popup').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2);
  assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2);
  await mkdir(resolve(repository, '.test-results'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const role = page.getByRole('combobox', { name: '成员 2 角色', exact: true });
    await role.scrollIntoViewIfNeeded();
    await role.focus();
    assert.equal(await role.evaluate(node => document.activeElement === node), true);
    const bounds = await role.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
    await page.screenshot({ path: resolve(repository, `.test-results/session-group-create-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('dialog.desk-popup').getByRole('button', { name: '创建会话组', exact: true }).click();
  await page.locator('dialog.desk-popup').waitFor({ state: 'detached' });
  await page.locator('.session:visible .session-name').filter({ hasText: '短剧开发 · 后端' }).waitFor();
  assert.equal(await page.locator('.session:visible .session-name').filter({ hasText: '后端（' }).textContent(),
    '短剧开发 · 后端（后端开发）');
  assert.equal(await page.locator('.session:visible .session-name').filter({ hasText: '前端（' }).textContent(),
    '短剧开发 · 前端（前端开发）');
  assert.equal(await page.locator('.session:visible').count(), 3);
  assert.deepEqual(await page.evaluate(() => window.state().sessions.filter(item => item.agentRole).map(item => item.agentRole.id)),
    ['backend', 'frontend']);
  assert.deepEqual(await page.evaluate(() => window.state().sessions.filter(item => item.groupId).map(item => item.cwd)),
    ['/project/backend', '/project', '/project/manager']);
  assert.deepEqual(await page.evaluate(() => window.state().sessions.filter(item => item.groupId).map(item => item.permission)),
    ['unrestricted', 'default', 'unrestricted']);
  const collaborationGroup = sidebar.locator('.group-choice').filter({ hasText: '短剧开发' });
  const ungrouped = sidebar.locator('.group-choice').filter({ hasText: '未分组' });
  assert.equal(await collaborationGroup.getAttribute('title'), '短剧开发 · 协作模式');
  assert.equal(await collaborationGroup.getAttribute('aria-label'), '短剧开发 · 协作模式');
  assert.equal(await ungrouped.locator('.group-collaboration-mark').count(), 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const marker = collaborationGroup.locator('.group-collaboration-mark');
    assert.equal(await marker.isVisible(), true);
    assert.equal(await marker.evaluate(node => getComputedStyle(node).stroke === getComputedStyle(node.parentElement).color), true);
    assert.equal((await collaborationGroup.boundingBox()).height, (await ungrouped.boundingBox()).height);
    await sidebar.screenshot({ path: resolve(repository, `.test-results/session-group-marker-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const coordinatorId = await page.evaluate(() => window.state().groups[0].coordinatorId);
  const coordinator = page.locator(`[data-session="${coordinatorId}"]`);
  assert.equal(await coordinator.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.session-header').getByRole('button', { name: '调整会话分组', exact: true }).count(), 0);
  await sidebar.locator(`[data-navigation="member:${coordinatorId}"]`).click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: '换组', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('menuitem', { name: '换组', exact: true }).getAttribute('title'), '组管理员为固定成员，不能换组');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.group-members').last().locator('.group-member').first().getAttribute('data-navigation'), `member:${coordinatorId}`);
  await page.evaluate(id => { window.state().sessions.find(session => session.id === id).coordinating = true; window.paint(); }, coordinatorId);
  for (const [activity, kind, label] of [['done', 'waiting', '本轮完成'], ['working', 'working', '运行中'], ['idle', 'waiting', '等待输入']]) {
    await page.evaluate(({ id, activity }) => {
      window.state().sessions.find(session => session.id === id).activity = activity;
      window.paint();
    }, { id: coordinatorId, activity });
    assert.equal(await coordinator.locator('.session-status').getAttribute('data-kind'), kind);
    assert.equal(await coordinator.locator('.session-status').getAttribute('title'), label);
    assert.equal(await sidebar.locator(`[data-navigation="member:${coordinatorId}"] .session-status`).getAttribute('data-kind'), kind);
  }
  await page.evaluate(id => { window.state().sessions.find(session => session.id === id).activity = 'done'; window.paint(); }, coordinatorId);
  assert.equal(await page.evaluate(id => window.state().sessions.find(session => session.id === id).activity, coordinatorId), 'done',
    'local supervision must not falsely mark the native terminal busy');
  assert.equal(await page.getByRole('button', { name: '收起短剧开发成员列表', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-session="old"]').isVisible(), false);
  await page.screenshot({ path: resolve(repository, '.test-results/session-groups-overview.png') });
  assert.equal(await coordinator.locator('.terminal-with-files').getAttribute('data-input-mode'), 'leader');
  const member = page.locator('.session:visible').filter({ hasText: '短剧开发 · 后端' });
  assert.equal(await member.locator('.terminal-with-files').getAttribute('data-input-mode'), 'normal');
  assert.equal(await member.locator('.xterm-helper-textarea').evaluate(node => node.readOnly), false);
  const memberId = await member.getAttribute('data-session');
  assert.equal(await page.getByRole('button', { name: /人工介入|返回自动协作/ }).count(), 0);
  assert.equal(await member.getByRole('button', { name: '清空输入', exact: true }).isVisible(), true);
  assert.equal(await member.getByRole('button', { name: '换行', exact: true }).isVisible(), true);
  await member.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('direct member input');
  await page.keyboard.press('Shift+Enter');
  await page.waitForFunction(id => window.writes.filter(write => write.sessionId === id).map(write => write.data).join('')
    === 'direct member input\x1b[13;2u', memberId);
  await page.evaluate(() => { window.writes = []; });
  await page.evaluate(id => {
    Object.assign(window.state().sessions.find(session => session.id === id), { blocked: 'question', question: '需要确认方案？' });
    window.paint();
  }, memberId);
  assert.equal(await page.locator('.question-popup:visible').count(), 1, 'member questions remain available alongside direct input');
  await page.getByRole('textbox', { name: '回答', exact: true }).fill('保留成员回答');
  await page.keyboard.press('Escape');
  assert.equal(await member.locator('.xterm-helper-textarea').evaluate(node => node.readOnly), false);
  await member.locator('.session-header .session-status').click();
  assert.equal(await page.locator('.question-popup:visible').count(), 1);
  assert.equal(await page.getByRole('textbox', { name: '回答', exact: true }).inputValue(), '保留成员回答');
  await page.getByRole('textbox', { name: '回答', exact: true }).press('Enter');
  await page.locator('.question-popup').filter({ has: page.getByText('需要确认方案？', { exact: true }) }).waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.writes), [
    { pluginId: 'one', sessionId: memberId, data: '\x1b[200~保留成员回答\x1b[201~' },
    { pluginId: 'one', sessionId: memberId, data: '\r' }
  ]);
  await page.evaluate(id => { window.state().sessions.find(session => session.id === id).question = null; window.paint(); }, memberId);
  assert.equal(await member.locator('.terminal-with-files').getAttribute('data-input-mode'), 'normal');
  assert.equal(await member.locator('.xterm-helper-textarea').evaluate(node => node.readOnly), false);
  assert.equal(await page.locator('.question-popup:visible').count(), 0);
  await page.evaluate(id => { window.state().sessions.find(session => session.id === id).blocked = 'approval'; window.paint(); }, memberId);
  assert.equal(await member.locator('.xterm-helper-textarea').evaluate(node => node.readOnly), false);
  await page.evaluate(id => {
    Object.assign(window.state().sessions.find(session => session.id === id), { exited: true, error: { code: 'SESSION_OFFLINE' } });
    window.paint();
  }, memberId);
  assert.equal(await member.getByRole('textbox', { name: '会话草稿' }).isVisible(), true);
  await page.evaluate(id => {
    Object.assign(window.state().sessions.find(session => session.id === id), { blocked: null, question: null, exited: false, error: null });
    window.paint();
  }, memberId);
  const first = coordinator;
  const id = await first.getAttribute('data-session');
  const frontend = page.locator('.session:visible').filter({ hasText: '短剧开发 · 前端' });
  const frontendId = await frontend.getAttribute('data-session');
  await frontend.getByRole('button', { name: '折叠', exact: true }).click();
  await member.locator('.xterm-screen').evaluate(node => { node.dataset.retained = 'member'; });
  await first.locator('.xterm-screen').evaluate(node => { node.dataset.retained = 'group'; });
  await first.getByRole('button', { name: '折叠', exact: true }).click();
  await page.locator('.group-choice').filter({ hasText: '未分组' }).click();
  assert.equal(await page.locator('.session:visible').count(), 1);
  assert.equal(await page.locator('[data-session="old"] .xterm-screen').getAttribute('data-retained'), 'old');
  await page.locator('.group-choice').filter({ hasText: '未分组' }).focus();
  await page.evaluate(id => {
    Object.assign(window.state().sessions.find(session => session.id === id), { blocked: 'question', question: '请选择实现方案？' });
    window.paint();
  }, id);
  const blockedIcon = page.locator(`[data-navigation="member:${id}"] .session-status`);
  assert.equal(await blockedIcon.getAttribute('data-kind'), 'blocked');
  assert.equal(await blockedIcon.locator('.kettle-steam').count(), 3);
  assert.equal(await blockedIcon.locator('svg *').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none')), true);
  assert.equal(await page.locator('.question-popup:visible').count(), 0);
  assert.equal(await page.locator('.group-choice:focus').count(), 1);
  await page.evaluate(id => {
    window.state().sessions.find(session => session.id === id).windowId = 'other-window';
    window.paint();
  }, frontendId);
  await page.locator('.group-choice').filter({ hasText: '短剧开发' }).click();
  assert.equal(await page.locator('.session:visible').count(), 3, 'selecting a group includes members from other plugin windows');
  assert.match(await page.locator(`[data-session="${frontendId}"]`).getAttribute('class'), /collapsed/);
  assert.equal(await member.locator('.xterm-screen').getAttribute('data-retained'), 'member');
  await page.getByRole('textbox', { name: '回答', exact: true }).fill('保留回答草稿');
  await page.locator('.group-choice').filter({ hasText: '未分组' }).click();
  assert.equal(await page.locator('.question-popup:visible').count(), 0);
  await page.locator('.group-choice').filter({ hasText: '短剧开发' }).click();
  assert.equal(await page.getByRole('textbox', { name: '回答', exact: true }).inputValue(), '保留回答草稿');
  await page.evaluate(id => {
    Object.assign(window.state().sessions.find(session => session.id === id), { blocked: null, question: null }); window.paint();
  }, id);
  assert.match(await page.locator(`[data-session="${id}"]`).getAttribute('class'), /collapsed/);
  assert.equal(await page.locator(`[data-session="${id}"] .xterm-screen`).getAttribute('data-retained'), 'group');
  await page.locator(`[data-session="${id}"]`).getByRole('button', { name: '最大化', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() => window.ready);
  await page.locator('.group-choice').filter({ hasText: '短剧开发' }).click();
  await page.locator(`[data-session="${id}"].maximized`).waitFor();
  await page.getByRole('button', { name: '恢复原大小', exact: true }).click();
  await page.locator('.group-choice').filter({ hasText: '短剧开发' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加组成员', exact: true }).click();
  await page.locator('dialog.desk-popup').getByRole('button', { name: '移入会话组', exact: true }).click();
  await page.locator('dialog.desk-popup').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.session:visible').count(), 4);
  assert.equal(await page.locator('[data-session="old"] .session-name').textContent(), '短剧开发 · 原有会话');
  await page.locator('.group-choice').filter({ hasText: '短剧开发' }).focus();
  await page.evaluate(() => { window.state().sessions[0].activity = 'working'; window.paint(); });
  assert.equal(await page.locator('.group-choice:focus').count(), 1);
  const workingIcon = page.locator('[data-navigation="member:old"] .session-status');
  assert.equal(await workingIcon.getAttribute('data-kind'), 'working');
  assert.equal(await workingIcon.locator('.kettle-heat').count(), 1);
  assert.equal(await workingIcon.locator('svg *').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none')), true);
  assert.notEqual(await page.locator('[data-session="old"] .kettle-heat').evaluate(node => getComputedStyle(node).animationName), 'none');
  await sidebar.locator('[data-navigation="member:old"]').click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: '换组', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('menuitem', { name: '换组', exact: true }).getAttribute('title'), '会话空闲后可换组');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '收起短剧开发成员列表', exact: true }).click();
  assert.equal(await page.locator('.group-members').last().isVisible(), false);
  assert.equal(await page.locator('.session:visible').count(), 4);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('.group-members').last().isVisible(), false);
  await page.getByRole('button', { name: '展开短剧开发成员列表', exact: true }).press('Enter');
  assert.equal(await page.locator('.group-members').last().isVisible(), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 720));
  await page.waitForFunction(() => document.querySelector('[role=separator]').getAttribute('aria-valuemax') < 200);
  assert.ok((await sidebar.boundingBox()).width <= 160);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 720));
  await page.waitForFunction(width => Math.abs(document.querySelector('.session-groups').getBoundingClientRect().width - width) < 2, savedWidth);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 720));
  await page.waitForFunction(() => document.querySelector('[role=separator]').getAttribute('aria-valuemax') < 200);
  await separator.focus();
  await page.keyboard.press('End');
  assert.equal(await separator.getAttribute('aria-valuenow'), await separator.getAttribute('aria-valuemax'));
  await page.keyboard.press('Home');
  assert.equal(await separator.getAttribute('aria-valuenow'), await separator.getAttribute('aria-valuemin'));
  const overlapping = await page.locator('.session:visible').evaluateAll(nodes => nodes.some(node => {
    const status = node.querySelector('.session-status').getBoundingClientRect();
    return [...node.querySelectorAll('.card-actions button:not([hidden])')].some(button => {
      const action = button.getBoundingClientRect();
      return action.left < status.right && action.right > status.left && action.top < status.bottom && action.bottom > status.top;
    });
  }));
  assert.equal(overlapping, false);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.dispatchEvent(new CustomEvent('desk-theme', { detail: theme })); }, theme);
    await page.screenshot({ path: resolve(repository, `.test-results/session-groups-${theme}.png`) });
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '工作台操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '历史', exact: true }).click();
  const historyRow = page.locator('.history-row').filter({ hasText: '历史后端' });
  await historyRow.getByRole('button', { name: '调整会话分组', exact: true }).click();
  const history = page.locator('dialog').filter({ has: page.getByRole('heading', { name: '会话历史', exact: true }) });
  const grouping = page.locator('dialog:has(> form > .dialog-heading > h2:text-is("调整会话分组"))');
  await grouping.getByRole('combobox', { name: '会话组', exact: true }).selectOption({ label: '短剧开发' });
  await page.keyboard.press('Escape');
  assert.equal(await history.isVisible(), true);
  assert.equal(await page.evaluate(() => window.state().archives[0].groupId), undefined);
  await historyRow.getByRole('button', { name: '调整会话分组', exact: true }).click();
  await grouping.getByRole('combobox', { name: '会话组', exact: true }).selectOption({ label: '短剧开发' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await grouping.getByRole('combobox', { name: '会话组', exact: true }).focus();
    const bounds = await grouping.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 2);
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
    await page.screenshot({ path: resolve(repository, `.test-results/session-history-group-${theme}.png`) });
  }
  await grouping.getByRole('button', { name: '保存分组', exact: true }).click();
  await grouping.waitFor({ state: 'detached' });
  assert.equal(await historyRow.getByText('短剧开发', { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.state().sessions.length), 4, 'historical assignment does not launch a window');
  await page.reload();
  await page.waitForFunction(() => window.ready);
  await page.getByRole('button', { name: '工作台操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '历史', exact: true }).click();
  await historyRow.waitFor({ state: 'visible' });
  assert.equal(await historyRow.getByText('短剧开发', { exact: true }).isVisible(), true);
  await historyRow.getByRole('button', { name: '恢复窗口', exact: true }).click();
  await history.waitFor({ state: 'detached' });
  await page.locator('.session:visible .session-name').filter({ hasText: '短剧开发 · 历史后端' }).waitFor();
  await page.locator('.group-choice').filter({ hasText: '短剧开发' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加组成员', exact: true }).click();
  const adding = page.locator('dialog').filter({ has: page.getByRole('heading', { name: '添加已有会话', exact: true }) });
  await adding.waitFor();
  assert.equal(await adding.locator('optgroup[label="历史会话"] option').count(), 1);
  await adding.getByRole('combobox', { name: '会话', exact: true }).selectOption('history-review');
  await page.screenshot({ path: resolve(repository, '.test-results/session-group-add-history.png') });
  await adding.getByRole('button', { name: '移入并恢复会话', exact: true }).click();
  await adding.waitFor({ state: 'detached' });
  await page.locator('.session:visible .session-name').filter({ hasText: '短剧开发 · 历史评审' }).waitFor();
  assert.equal(await page.evaluate(() => window.state().archives.length), 0);
  const choice = page.locator('.group-choice').filter({ hasText: '短剧开发' });
  await choice.focus();
  await choice.press('Shift+F10');
  await page.getByRole('menuitem', { name: '修改组名', exact: true }).click();
  let editing = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改组名', exact: true }) });
  await editing.getByRole('textbox', { name: '组名', exact: true }).fill('取消的组名');
  await page.keyboard.press('Escape');
  assert.equal(await choice.isVisible(), true);
  await choice.click({ button: 'right' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const menu = page.getByRole('menu', { name: '会话组操作' });
    const bounds = await menu.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
    await page.screenshot({ path: resolve(repository, `.test-results/session-group-menu-${theme}.png`) });
  }
  await page.getByRole('menuitem', { name: '修改组名', exact: true }).click();
  await editing.getByRole('textbox', { name: '组名', exact: true }).fill('联合开发');
  await editing.getByRole('button', { name: '保存组名', exact: true }).click();
  await editing.waitFor({ state: 'detached' });
  await page.locator('.session:visible .session-name').filter({ hasText: '联合开发 · 历史评审' }).waitFor();
  const renamed = page.locator('.group-choice').filter({ hasText: '联合开发' });
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除会话组', exact: true }).click();
  const deleting = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除会话组', exact: true }) });
  const centered = await deleting.boundingBox();
  assert.ok(Math.abs(centered.x + centered.width / 2 - (await page.evaluate(() => innerWidth)) / 2) < 2);
  await deleting.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await renamed.isVisible(), true);
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除会话组', exact: true }).click();
  await deleting.getByRole('button', { name: '确认删除会话组', exact: true }).click();
  await deleting.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.session:visible').count(), 6);
  assert.equal(await page.evaluate(() => window.state().groups.length), 0);
  assert.equal(await page.locator('.group-members .icon-button').count(), 0);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  await page.locator('.group-choice').filter({ hasText: '未分组' }).click();
  assert.equal(await page.locator('.session:visible').count(), 6);
  assert.equal(await page.locator('#toast').isVisible(), false);
  await page.getByRole('button', { name: '工作台操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '创建会话组', exact: true }).click();
  await page.locator('[name=groupName]').fill('普通分组');
  await page.locator('[name=memberCount]').fill('2');
  await page.locator('dialog.desk-popup').getByRole('button', { name: '创建会话组', exact: true }).click();
  await page.locator('dialog.desk-popup').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.session:visible').count(), 2);
  assert.equal(await page.evaluate(() => window.state().groups[0].collaboration), false);
  assert.equal(await sidebar.locator('.group-collaboration-mark').count(), 0);
  assert.equal(await page.evaluate(() => window.state().groups[0].coordinatorId), undefined);
  assert.equal(await page.locator('.session:visible [data-input-mode=normal]').count(), 2);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  await page.locator('.group-choice').filter({ hasText: '普通分组' }).click();
  assert.equal(await page.locator('.session:visible [data-input-mode=normal]').count(), 2);
  const ordinaryMemberId = await page.locator('.session:visible').last().getAttribute('data-session');
  await page.evaluate(id => {
    window.state().sessions.find(session => session.id === id).windowId = 'other-window';
    window.paint();
  }, ordinaryMemberId);
  await page.goto(`${page.url().split('?')[0]}?fresh=1`);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('.session:visible').count(), 0, 'startup leaves group selection to the user');
  await page.locator('.group-choice').filter({ hasText: '普通分组' }).click();
  assert.equal(await page.locator('.session:visible').count(), 2, 'fresh plugin windows can display the whole selected group');
  const row = sidebar.locator(`[data-navigation="member:${ordinaryMemberId}"]`);
  const moveMenu = page.getByRole('menu', { name: '会话操作', exact: true });
  const memberGrouping = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '调整会话分组', exact: true }) });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      window.dispatchEvent(new CustomEvent('desk-theme', { detail: theme }));
    }, theme);
    await row.click({ button: 'right', position: { x: 25, y: 12 } });
    const action = moveMenu.getByRole('menuitem', { name: '换组', exact: true });
    assert.equal(await action.getAttribute('title'), '换组');
    assert.equal(await action.textContent(), '换组', 'member menu keeps a short visible label beside its icon');
    assert.equal(await action.locator('svg[stroke=currentColor]').count(), 1);
    const menuBox = await moveMenu.boundingBox();
    const rowBox = await row.boundingBox();
    assert.ok(Math.abs(menuBox.x - (rowBox.x + 25 + 8)) < 2, 'member menu opens beside the pointer');
    assert.ok(Math.abs(menuBox.y - (rowBox.y + 12)) < 2);
    assert.ok(menuBox.width >= 180, 'option menus share a readable text layout');
    await page.screenshot({ path: resolve(repository, `.test-results/session-member-menu-${theme}.png`) });
    await page.keyboard.press('Escape');
    await moveMenu.waitFor({ state: 'detached' });
    await page.waitForFunction(id => document.activeElement?.dataset.navigation === `member:${id}`, ordinaryMemberId);
  }
  await row.press('Shift+F10');
  await moveMenu.getByRole('menuitem', { name: '换组', exact: true }).click();
  await memberGrouping.getByRole('combobox', { name: '会话组', exact: true }).selectOption('');
  await memberGrouping.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(await page.evaluate(id => window.state().sessions.find(session => session.id === id).groupId, ordinaryMemberId));
  await row.click({ button: 'right' });
  await moveMenu.getByRole('menuitem', { name: '换组', exact: true }).click();
  await memberGrouping.getByRole('combobox', { name: '会话组', exact: true }).selectOption('');
  await memberGrouping.getByRole('button', { name: '保存分组', exact: true }).click();
  await memberGrouping.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(id => window.state().sessions.find(session => session.id === id).groupId, ordinaryMemberId), '');
  await page.locator('.group-choice').filter({ hasText: '未分组' }).click();
  await row.click({ button: 'right' });
  await moveMenu.getByRole('menuitem', { name: '换组', exact: true }).click();
  const targetGroup = await page.evaluate(() => window.state().groups[0].id);
  await memberGrouping.getByRole('combobox', { name: '会话组', exact: true }).selectOption(targetGroup);
  await memberGrouping.getByRole('button', { name: '保存分组', exact: true }).click();
  await memberGrouping.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(id => window.state().sessions.find(session => session.id === id).groupId, ordinaryMemberId), targetGroup);
  assert.equal(await page.locator('.session-header').getByRole('button', { name: '调整会话分组', exact: true }).count(), 0);
  const ordinary = sidebar.locator('.group-choice').filter({ hasText: '普通分组' });
  await page.evaluate(id => { window.state().sessions.find(session => session.groupId === id).activity = 'working'; window.paint(); }, targetGroup);
  await ordinary.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '归档会话组', exact: true }).click();
  const archiving = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '归档会话组', exact: true }) });
  await archiving.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(id => window.state().sessions.filter(session => session.groupId === id).length, targetGroup), 2);
  assert.equal(await page.evaluate(id => window.state().sessions.find(session => session.groupId === id).activity, targetGroup), 'working');
  await ordinary.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '归档会话组', exact: true }).click();
  assert.match(await archiving.innerText(), /组内任务将强制停止/);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: resolve(repository, `.test-results/session-group-archive-${theme}.png`) });
  }
  await archiving.getByRole('button', { name: '确认归档会话组', exact: true }).click();
  await archiving.waitFor({ state: 'detached' });
  assert.equal(await ordinary.count(), 0);
  await page.getByRole('button', { name: '工作台操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '历史', exact: true }).click();
  const section = page.locator('.history-group').filter({ has: page.locator('strong', { hasText: '普通分组' }) });
  await section.locator('.history-row').nth(1).waitFor({ state: 'visible' });
  assert.equal(await section.locator('.history-row').count(), 2);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: resolve(repository, `.test-results/session-group-history-${theme}.png`) });
  }
  await section.getByRole('button', { name: '恢复普通分组全部会话', exact: true }).click();
  await page.waitForFunction(id => window.state().sessions.filter(session => session.groupId === id).length === 2, targetGroup);
  await page.locator('dialog.history-dialog[aria-busy=false]').waitFor();
  assert.equal(await ordinary.count(), 1);
  assert.deepEqual(errors, []);
});
