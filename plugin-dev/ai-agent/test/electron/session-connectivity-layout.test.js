import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
async function workspace(t, scenario, layout, sessions, sidebarStyles = false) {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-connectivity-layout-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    ${sidebarStyles ? "import './plugin-dev/ai-agent/src/renderer/session-groups.css';" : ''}
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import './desk/src/resource/controls.css';
    import '@xterm/xterm/css/xterm.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    window.postMessage = () => {};
    const pluginId = 'ai-agent-sessions';
    const base = { pluginId, adapterId: 'codex', name: '会话', cwd: '/project', activity: 'idle', protocol: 'managed-terminal' };
    window.layout = ${layout ? JSON.stringify(layout) : scenario === 'layout' ? `{ sizes: { first: { width: 660, height: 405 }, second: { width: 660, height: 405 } },
      positions: { first: { col: 0, row: 0 }, second: { col: 28, row: 0 } }, collapsed: ['first', 'second'] }` : '{}'};
    window.sessions = ${sessions ? JSON.stringify(sessions) + '.map(session => ({ ...base, ...session }))' : scenario === 'layout' ? "['first', 'second'].map(id => ({ ...base, id, name: id }))" : `[{ ...base, id: 'offline', exited: true, activity: 'offline',
      error: { code: 'SESSION_OFFLINE', message: '连接不可用' } }]`};
    window.calls = [];
    api.host.getWindowContext = async () => ({ id: 'fixture' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => window.layout;
    api.storage.saveLayout = async (_, value) => { window.saved = structuredClone(value); };
    api.storage.getAdapterConfig = async () => ({});
    api.sessions.recover = async () => ({ sessions: [], archives: [] });
    api.sessions.list = async () => ({ sessions: window.sessions });
    api.sessions.attachWindow = async () => {};
    api.sessions.attach = async () => ({ data: ${scenario === 'concise' ? JSON.stringify('Native tool details\r\n\r\n> ') : JSON.stringify('Error: account/read failed during TUI bootstrap')}, sequence: 0 });
    api.sessions.transcript = async () => ({ available: true, messages: [{ role: 'user', text: '请验证这次修改' }, { role: 'assistant', text: '**验证完成**\\n\\n- 已通过\\n- 请确认下一步' }] });
    api.sessions.resize = async () => {};
    api.sessions.write = async (_, id, data) => { window.calls.push([id, data]); };
    api.sessions.restore = async () => {
      window.calls.push('restore');
      if (window.failRetry) { throw Error('仍无法连接'); }
      window.sessions = [{ ...base, id: 'replacement', restoredFrom: 'offline', activity: 'unknown' }];
      window.refresh({ sessions: window.sessions });
      return window.sessions[0];
    };
    api.events.sessionsChanged = callback => { window.refresh = callback; return () => {}; };
    window.mount = () => mountWorkspace(document.querySelector('main'), { pluginId,
      adapters: [{ id: 'codex', capabilities: { inputProtocol: 'codex' } }] });
    window.dispose = await window.mount();
    window.ready = true;`, resolveDir: repository, sourcefile: 'connectivity-layout.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main id="workspace"></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready);
  const resize = async (width, height = 900) => {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height]);
    await page.waitForFunction(width => innerWidth === width, width);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  };
  return { page, resize };
}

test('saved session geometry scales with the desktop and roundtrips without losing collapsed or maximized state', { timeout: 60000 }, async t => {
  const { page, resize } = await workspace(t, 'layout');
  const cards = page.locator('.session');
  const geometry = () => cards.evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height, right: box.right };
  }));
  // Legacy saved dimensions were made on a wider desktop; both cards must remain on one row.
  const initial = await geometry();
  assert.ok(initial.every(box => box.left >= 0 && box.right <= 640));
  const shots = join(repository, 'plugin-dev/dist/verification/session-connectivity-layout-0.6.72');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1800, 1400, 980, 640, 360, 1800]) {
      await resize(width);
      const boxes = await geometry();
      assert.ok(boxes.every(box => box.left >= 0 && box.right <= width));
      assert.equal(boxes[0].height, 35);
      if (width >= 980) {
        assert.equal(boxes[0].top, boxes[1].top);
        assert.ok(boxes[1].left >= boxes[0].right);
      } else {
        assert.ok(boxes[1].top >= boxes[0].top + boxes[0].height);
      }
      await page.screenshot({ path: join(shots, `${theme}-${width}-layout.png`) });
    }
  }
  await cards.nth(0).getByRole('button', { name: '展开', exact: true }).click();
  const large = (await geometry())[0];
  await resize(1400, 700);
  const smaller = (await geometry())[0];
  assert.ok(smaller.width < large.width);
  assert.ok(smaller.height < large.height);
  await cards.nth(0).getByRole('button', { name: '最大化', exact: true }).click();
  await resize(980, 650);
  assert.equal(await page.locator('.session.maximized').evaluate(node => node.offsetWidth), 980);
  await page.getByRole('button', { name: '恢复原大小', exact: true }).click();
  assert.equal(await cards.nth(1).evaluate(node => node.classList.contains('collapsed')), true);
  await resize(1800, 900);
  assert.equal((await geometry())[0].width, large.width);
  assert.equal((await geometry())[0].height, large.height);
  assert.deepEqual(await page.evaluate(() => window.saved.positions), { first: { col: 0, row: 0 }, second: { col: 28, row: 0 } });
  await resize(1400, 700);
  const beforeDrag = (await geometry())[0];
  const header = await cards.nth(0).locator('.session-header').boundingBox();
  await page.mouse.move(header.x + 60, header.y + 16);
  await page.mouse.down();
  await page.mouse.move(header.x + 84, header.y + 88, { steps: 4 });
  await page.mouse.up();
  assert.equal((await geometry())[0].width, beforeDrag.width);
  await resize(1800, 900);
  assert.equal((await geometry())[0].width, large.width);
  assert.equal((await geometry())[0].height, large.height);
});

test('restored cards with different sizes and new cards scale together across responsive breakpoints', { timeout: 60000 }, async t => {
  const layout = { columns: 67, viewportHeight: 1035,
    sizes: { first: { width: 753, height: 405, viewportWidth: 1608, viewportHeight: 1035 },
      second: { width: 774, height: 405, viewportWidth: 1608, viewportHeight: 1035 } },
    positions: { first: { col: 0, row: 18 }, second: { col: 34, row: 18 } }, collapsed: ['first', 'second', 'third'] };
  const sessions = ['first', 'second', 'third'].map(id => ({ id: `runtime-${id}`, restoredFrom: id, name: id }));
  const { page, resize } = await workspace(t, 'layout', layout, sessions);
  const geometry = () => page.locator('.session').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { width: box.width, top: box.top, right: box.right, left: box.left };
  }));
  await resize(1630, 1035);
  const wide = await geometry();
  for (const width of [1630, 1308, 1251, 1250, 1240, 1001, 1000, 980, 1630]) {
    await resize(width, 1035);
    const boxes = await geometry();
    const ratio = Math.floor((width - (width <= 1000 ? 24 : 32)) / 24) / 66;
    boxes.forEach((box, index) => assert.ok(Math.abs(box.width + 12 - (wide[index].width + 12) * ratio) < 48,
      `card ${index} must scale with the desktop at ${width}: ${JSON.stringify({ wide: wide[index], box })}`));
    assert.equal(boxes[0].top, boxes[1].top);
  }
  // A real resize handle must switch only this card to saved sizing without changing future scale ratios.
  const third = page.locator('.session').nth(2);
  const before = await third.boundingBox();
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 51, before.y + before.height - 3, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.saved?.sizes.third?.viewportWidth);
  const manual = (await geometry())[2];
  assert.ok(manual.width < before.width);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1240, 980, 360, 1630]) {
      await resize(width, 1035);
      const boxes = await geometry();
      assert.ok(boxes.every(box => box.left >= 0 && box.right <= width));
      if (width >= 980) {
        const ratio = Math.floor((width - (width <= 1000 ? 24 : 32)) / 24) / 66;
        assert.ok(Math.abs(boxes[2].width + 12 - (manual.width + 12) * ratio) < 24);
      }
      const shots = join(repository, 'plugin-dev/dist/verification/session-connectivity-layout-0.6.72');
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `${theme}-${width}-mixed-layout.png`) });
    }
  }
});

test('manual resizing aligns neighboring cards and persists matching geometry', { timeout: 60000 }, async t => {
  const layout = { columns: 56, viewportHeight: 900,
    sizes: { first: { width: 660, height: 405 }, second: { width: 612, height: 360 } },
    positions: { first: { col: 0, row: 0 }, second: { col: 0, row: 20 } }, collapsed: [] };
  const { page, resize } = await workspace(t, 'layout', layout);
  await resize(1400);
  const cards = page.locator('.session');
  const target = await cards.nth(0).boundingBox();
  const before = await cards.nth(1).boundingBox();
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down();
  await page.mouse.move(before.x + target.width - 10, before.y + target.height - 10, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.saved?.sizes.second?.height === 405, null, { timeout: 2000 });
  const aligned = await cards.nth(1).boundingBox();
  assert.equal(aligned.width, target.width);
  assert.equal(aligned.height, target.height);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await resize(980);
    await resize(1400);
    assert.equal((await cards.nth(1).boundingBox()).width, (await cards.nth(0).boundingBox()).width);
    const shots = join(repository, 'plugin-dev/dist/verification/session-alignment-0.6.80');
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${theme}.png`) });
  }
});

test('dragging can use the right edge of the canvas and retains its position after release and reload', { timeout: 60000 }, async t => {
  const layout = { columns: 63, viewportHeight: 900, sizes: { first: { width: 1356, height: 405 } },
    positions: { first: { col: 0, row: 0 } }, groupSidebar: { hidden: true } };
  const { page, resize } = await workspace(t, 'layout', layout, [{ id: 'first' }]);
  const card = page.locator('.session');
  const geometry = () => card.evaluate(node => {
    const box = node.getBoundingClientRect();
    const canvas = node.parentElement.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, gap: canvas.right - box.right };
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1558, 980, 360]) {
      await resize(width);
      for (const sidebar of [false, true]) {
        if (sidebar) { await page.getByRole('button', { name: '显示分组栏', exact: true }).click(); }
        const header = await card.locator('.session-header').boundingBox();
        await page.mouse.move(header.x + 40, header.y + 16);
        await page.mouse.down();
        await page.mouse.move(width - 2, header.y + 16, { steps: 6 });
        const preview = await geometry();
        assert.ok(Math.abs(preview.gap) < 1, `unused right edge: ${JSON.stringify({ theme, width, sidebar, preview })}`);
        await page.mouse.up();
        assert.deepEqual(await geometry(), preview, 'releasing the drag must not jump back to the grid');
        await page.waitForFunction(() => window.saved?.positions.first);
        await page.evaluate(async () => {
          await window.dispose();
          window.layout = structuredClone(window.saved);
          window.dispose = await window.mount();
        });
        assert.deepEqual(await geometry(), preview, 'reopening must restore the position at the edge');
        if (width === 1558) {
          const shots = join(repository, 'plugin-dev/dist/verification/session-drag-0.6.89');
          await mkdir(shots, { recursive: true });
          await page.screenshot({ path: join(shots, `${theme}-${sidebar ? 'sidebar' : 'canvas'}.png`) });
        }
        if (sidebar) { await page.getByRole('button', { name: '隐藏分组栏', exact: true }).click(); }
      }
    }
  }
});

test('offline sessions keep a usable local draft and reconnect without automatically sending it', { timeout: 60000 }, async t => {
  const { page, resize } = await workspace(t, 'offline');
  const draft = page.getByRole('textbox', { name: '会话草稿' });
  await draft.waitFor({ timeout: 4000 });
  assert.equal(await page.locator('.terminal-mount').isVisible(), false);
  assert.equal(await page.locator('.session-error').isVisible(), false);
  assert.equal(await page.locator('.session-status').getAttribute('data-kind'), 'offline');
  assert.equal(await page.locator('.session-status .kettle-plug').count(), 1);
  await draft.fill('网络恢复后继续\n第二行');
  await page.evaluate(() => { window.failRetry = true; });
  await page.getByRole('button', { name: '重新连接会话', exact: true }).click();
  await page.getByText('仍无法连接', { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), '网络恢复后继续\n第二行');
  await page.evaluate(() => { window.failRetry = false; });
  await page.getByRole('button', { name: '重新连接会话', exact: true }).click();
  await page.locator('[data-session="replacement"]').waitFor();
  assert.equal(await draft.inputValue(), '网络恢复后继续\n第二行');
  const paste = page.getByRole('button', { name: '放入会话输入框', exact: true });
  assert.equal(await paste.isDisabled(), true);
  await page.evaluate(() => { window.sessions[0].activity = 'idle'; window.refresh({ sessions: window.sessions }); });
  assert.equal(await paste.isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.calls), ['restore', 'restore']);
  await paste.click();
  assert.deepEqual(await page.evaluate(() => window.calls), ['restore', 'restore', ['replacement', '\x1b[200~网络恢复后继续\n第二行\x1b[201~']]);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  assert.equal(await page.locator('.session-status').getAttribute('data-kind'), 'offline');
  assert.equal(await page.locator('.terminal-mount').isVisible(), true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  assert.equal(await page.locator('.session-status').getAttribute('data-kind'), 'waiting');
  await page.evaluate(() => {
    Object.assign(window.sessions[0], { exited: true, activity: 'offline', error: { code: 'SESSION_OFFLINE' } });
    window.refresh({ sessions: window.sessions });
  });
  const shots = join(repository, 'plugin-dev/dist/verification/session-connectivity-layout-0.6.72');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [980, 360]) {
      await resize(width);
      await draft.focus();
      assert.equal(await draft.evaluate(node => node.matches(':focus-visible')), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(shots, `${theme}-${width}-offline.png`) });
    }
  }
});


test('real group sidebar keeps every session within the canvas through viewport and sidebar changes', { timeout: 60000 }, async t => {
  const layout = { columns: 80, viewportHeight: 900, groupSidebar: { hidden: true },
    sizes: Object.fromEntries(['first', 'second', 'third', 'fourth', 'fifth'].map(id =>
      [id, { width: 948, height: 405, viewportWidth: 1920, viewportHeight: 900 }])),
    positions: { first: { col: 0, row: 0 }, second: { col: 40, row: 0 }, third: { col: 40, row: 3 },
      fourth: { col: 0, row: 18 }, fifth: { col: 0, row: 20 } }, collapsed: ['second', 'third', 'fourth', 'fifth'] };
  const { page, resize } = await workspace(t, 'layout', layout,
    ['first', 'second', 'third', 'fourth', 'fifth'].map(id => ({ id, name: id })), true);
  for (const width of [2000, 1500, 1000, 640, 360, 2000]) {
    await resize(width);
    for (let toggle = 0; toggle < 2; toggle++) {
      await page.getByRole('button', { name: /^(显示|隐藏)分组栏$/ }).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const boxes = await page.evaluate(() => {
        const canvas = document.querySelector('.windows').getBoundingClientRect();
        return { canvas: { left: canvas.left, right: canvas.right }, cards: [...document.querySelectorAll('.session')].map(node => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        }) };
      });
      assert.ok(boxes.canvas.right <= width, JSON.stringify({ width, toggle, boxes }));
      assert.ok(boxes.cards.every(box => box.left >= boxes.canvas.left && box.right <= boxes.canvas.right + 1),
        JSON.stringify({ width, toggle, boxes }));
    }
  }
});


test('mixed saved and automatic cards retain geometry after refresh, hide and sidebar roundtrips', { timeout: 60000 }, async t => {
  const layout = { columns: 25, viewportHeight: 900, groupSidebar: { hidden: true },
    positions: { first: { col: 0, row: 8 }, fourth: { col: 16, row: 4 } }, collapsed: ['second', 'fourth'] };
  const { page, resize } = await workspace(t, 'layout', layout,
    ['first', 'second', 'third', 'fourth'].map(id => ({ id, name: id })), true);
  await resize(2000);
  const geometry = () => page.locator('.session').evaluateAll(nodes => nodes.map(node =>
    ({ id: node.dataset.session, left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight })));
  const initial = await geometry();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (let iteration = 0; iteration < 3; iteration++) {
      await page.evaluate(() => { window.refresh({ sessions: window.sessions }); });
      await page.getByRole('button', { name: '显示分组栏', exact: true }).click();
      await resize(640);
      await page.evaluate(() => { document.querySelector('main').hidden = true; });
      await resize(1000);
      await page.evaluate(() => { document.querySelector('main').hidden = false; });
      await page.getByRole('button', { name: '隐藏分组栏', exact: true }).click();
      await resize(2000);
      assert.deepEqual(await geometry(), initial, 'temporary canvas changes must not alter the normal layout');
    }
  }
});


test('concise display switches safely, retains the native composer and remembers its selection', { timeout: 60000 }, async t => {
  const { page, resize } = await workspace(t, 'concise', {}, [{ id: 'first' }]);
  await resize(1000, 700);
  const toggle = page.getByRole('button', { name: '切换为简洁视图', exact: true });
  assert.equal(await toggle.locator('svg').count(), 1);
  assert.equal(await toggle.evaluate(button => button.parentElement.classList.contains('session-footer')), true);
  assert.equal(await page.locator('.session-header .session-display-toggle').count(), 0);
  await toggle.click();
  const surface = page.getByLabel('简洁会话内容', { exact: true });
  await surface.locator('strong').waitFor();
  assert.equal(await surface.locator('strong').textContent(), '验证完成');
  assert.equal(await surface.locator('li').count(), 2);
  assert.equal((await surface.locator('[data-role="user"] .session-concise-body').textContent()).trim(), '请验证这次修改');
  assert.deepEqual(await surface.locator('.session-concise-role').allTextContents(), ['用户', 'AI']);
  assert.equal(await surface.locator('[data-role="assistant"] strong').textContent(), '验证完成');
  await page.waitForFunction(() => window.saved?.concise.first === true);
  await page.waitForFunction(() => {
    const surface = document.querySelector('.session-concise');
    return surface.clientHeight > 200;
  });
  const shots = join(repository, 'plugin-dev/dist/verification/session-display-0.6.132');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      window.dispatchEvent(new CustomEvent('desk-theme', { detail: theme }));
    }, theme);
    for (const width of [1000, 400]) {
      await resize(width, 700);
      assert.equal(await surface.isVisible(), true);
      const reading = await surface.boundingBox();
      const prose = await surface.locator('li').last().boundingBox();
      assert.ok(prose.y >= reading.y && prose.y + prose.height <= reading.y + reading.height);
      const input = page.locator('.xterm-helper-textarea');
      await input.focus();
      await page.keyboard.type('hello');
      await page.waitForFunction(() => window.calls.some(call => Array.isArray(call) && call[1].includes('h')));
      const box = await page.getByRole('button', { name: '切换为完整视图', exact: true }).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await page.screenshot({ path: join(shots, `${theme}-${width}.png`) });
    }
  }
  await page.evaluate(() => {
    window.sessions[0].blocked = 'permission';
    window.refresh({ sessions: window.sessions });
  });
  await surface.waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    delete window.sessions[0].blocked;
    window.refresh({ sessions: window.sessions });
  });
  await surface.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '切换为完整视图', exact: true }).click();
  await surface.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.saved?.concise.first === false);
  await page.getByRole('button', { name: '切换为简洁视图', exact: true }).click();
  await page.waitForFunction(() => window.saved?.concise.first === true);
  await page.evaluate(async () => {
    window.dispose();
    window.layout = window.saved;
    window.dispose = await window.mount();
  });
  await page.getByRole('button', { name: '切换为完整视图', exact: true }).waitFor();
  await page.getByLabel('简洁会话内容', { exact: true }).waitFor();
});
