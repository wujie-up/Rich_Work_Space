import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner, alive } from '../../../../desk/test/electron/helpers.js';

async function setup(t, { appleTouch = false } = {}) {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve(`plugin-dev/dist/ai-agent-sessions-${process.env.AGENT_TEST_VERSION || JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json'))).version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(owner => workDesk.plugins.enable(owner), owner);
  const fixture = join(data, 'interaction.cjs');
  await writeFile(fixture, `process.stdin.setRawMode(true);
process.stdin.resume();
console.log('READY');
process.stdout.write('\\x1b]7501;app=codex:state=idle\\x07');
process.stdin.on('data', data => {
  const input = data.toString();
  if (input.includes('\\x03')) { process.exit(0); }
  if (input === 'rich-history') {
    process.stdout.write(Array.from({ length: 3000 }, (_, i) => 'row ' + i + ' ' +
      Array.from({ length: 25 }, (_, j) => '\\x1b[3' + (j % 7 + 1) + 'm字A').join('') + '\\x1b[0m\\r\\n').join(''));
  } else if (input === 'history') {
    process.stdout.write(Array.from({ length: 3000 }, (_, i) => 'history ' + i + '\\r\\n').join(''));
  } else { console.log('INPUT=' + JSON.stringify(input)); }
});`);
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner,
    { custom: { command, args, inputProtocol: 'codex' } }), { owner, command: process.execPath, args: [fixture] });
  if (appleTouch) {
    await app.context().addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15' });
      Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
  }
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  const view = page.locator('iframe[title="AI Agent 会话"]').contentFrame();
  const create = async name => {
    await view.getByRole('button', { name: '工作台操作', exact: true }).press('Enter');
    await view.locator('.workspace-menu').getByRole('menuitem', { name: '新建会话', exact: true }).press('Enter');
    await view.locator('select[name="adapter"]').selectOption('custom');
    await view.locator('input[name="sessionName"]').fill(name);
    await view.locator('input[name="cwd"]').fill(data);
    await view.getByRole('button', { name: '启动会话', exact: true }).click();
    await view.locator('.session-name').filter({ hasText: name }).waitFor();
    const record = (await page.evaluate(owner => agentDesk.sessions.list(owner), owner)).sessions.find(s => s.name === name);
    await output(page, record.id, 'READY');
    return record;
  };
  return { page, view, create };
}

test('interrupt shortcuts and button preserve the native session', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const session = await create('中断验证');
  const card = view.locator(`[data-session="${session.id}"]`);
  await card.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await output(page, session.id, 'INPUT="\\u001b"');
  await page.keyboard.press('Alt+c');
  await card.getByRole('button', { name: '中断', exact: true }).click();
  await page.waitForFunction(async ({ owner, id }) =>
    ((await agentDesk.sessions.attach(owner, id)).data.match(/INPUT=/g) || []).length === 3, { owner, id: session.id });
  assert.equal(alive(session.pid), true);
  const result = await page.evaluate(owner => agentDesk.sessions.list(owner), owner);
  assert.equal(result.archives.length, 0);
  assert.equal(result.sessions.length, 1);
});

test('cards move on the grid, keep terminal nodes and persist their positions', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const first = await create('拖动一');
  const second = await create('拖动二');
  const a = view.locator(`[data-session="${first.id}"]`);
  const b = view.locator(`[data-session="${second.id}"]`);
  await a.locator('.xterm-screen').evaluate(node => { node.dataset.retained = 'yes'; });
  const from = await b.locator('.drag-handle').boundingBox();
  const to = await a.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 12, { steps: 15 });
  assert.deepEqual(await view.locator('.session').evaluateAll(nodes => nodes.map(node => node.dataset.session)),
    [first.id, second.id], 'live terminals stay in place until the pointer is released');
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.deepEqual(await view.locator('.session').evaluateAll(nodes => nodes.map(node => node.dataset.session)), [first.id, second.id]);
  assert.ok((await b.boundingBox()).y <= (await a.boundingBox()).y);
  assert.equal(await a.locator('.xterm-screen').getAttribute('data-retained'), 'yes');
  const layout = await page.evaluate(owner => agentDesk.storage.getLayout(owner), owner);
  assert.ok(layout.positions[first.id]);
  assert.ok(layout.positions[second.id]);
  await mkdir('.test-results', { recursive: true });
  await page.screenshot({ path: resolve('.test-results/agent-session-drag-and-interrupt.png') });
});

test('long terminal history scrolls locally without sending input or rebuilding cards', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const session = await create('滚动验证');
  const card = view.locator(`[data-session="${session.id}"]`);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'history'), { owner, id: session.id });
  await output(page, session.id, 'history 2999');
  await page.waitForTimeout(400);
  const slider = card.locator('.xterm-scrollable-element .scrollbar.vertical .slider');
  const scrollBefore = await slider.getAttribute('style');
  await view.locator('.windows').evaluate(node => {
    window.moves = 0;
    new MutationObserver(records => { window.moves += records.length; }).observe(node, { childList: true });
    window.frameTimes = [];
    window.scrollProbe = true;
    let previous = performance.now();
    const sample = now => {
      window.frameTimes.push(now - previous);
      previous = now;
      if (window.scrollProbe) { requestAnimationFrame(sample); }
    };
    requestAnimationFrame(sample);
  });
  const box = await card.locator('.xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -70);
    await page.waitForTimeout(16);
  }
  const probe = await view.locator('.windows').evaluate(() => {
    window.scrollProbe = false;
    return { moves: window.moves, frames: window.frameTimes, scroll: document.querySelector('.xterm-scrollable-element .scrollbar.vertical .slider').getAttribute('style') };
  });
  assert.equal(probe.moves, 0);
  assert.notEqual(probe.scroll, scrollBefore, 'history viewport moves');
  const replay = await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id), { owner, id: session.id });
  assert.equal(replay.data.includes('INPUT='), false);
  const sorted = probe.frames.slice(2).sort((a, b) => a - b);
  t.diagnostic(`scroll frames=${sorted.length}, p95=${sorted[Math.floor(sorted.length * .95)].toFixed(1)}ms, max=${sorted.at(-1).toFixed(1)}ms`);
});


test('terminal bottom rows remain inside the viewport after resizing', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const session = await create('底部验证');
  const card = view.locator(`[data-session="${session.id}"]`);
  for (const height of [405, 260, 190]) {
    await card.evaluate((node, height) => { node.style.height = `${height}px`; }, height);
    await page.waitForTimeout(300);
    const geometry = await card.evaluate(node => {
      const mount = node.querySelector('.terminal-mount').getBoundingClientRect();
      const screen = node.querySelector('.xterm-screen').getBoundingClientRect();
      const footer = node.querySelector('.session-footer').getBoundingClientRect();
      return { screenBottom: screen.bottom, mountBottom: mount.bottom, footerBottom: footer.bottom,
        cardBottom: node.getBoundingClientRect().bottom };
    });
    t.diagnostic(JSON.stringify({ height, ...geometry }));
    assert.ok(geometry.screenBottom <= geometry.mountBottom + 1, 'last terminal row must not be clipped');
    assert.ok(geometry.footerBottom <= geometry.cardBottom, 'footer remains visible');
  }
  await mkdir('.test-results', { recursive: true });
  assert.equal(await card.locator('.xterm-viewport').evaluate(node => getComputedStyle(node).backgroundColor),
    await card.locator('.xterm').evaluate(node => getComputedStyle(node).backgroundColor), 'terminal padding follows theme');
  await page.screenshot({ path: resolve('.test-results/agent-terminal-bottom.png') });
});

test('dragging a session name into empty grid space moves the card', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const first = await create('名字拖动一');
  const second = await create('名字拖动二');
  const card = view.locator(`[data-session="${first.id}"]`);
  const from = await card.locator('.session-name').boundingBox();
  const last = await view.locator(`[data-session="${second.id}"]`).boundingBox();
  await page.mouse.move(from.x + 10, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height + 12, { steps: 20 });
  await view.locator('.session-drag-preview').waitFor();
  await mkdir('.test-results', { recursive: true });
  await page.screenshot({ path: resolve('.test-results/agent-session-drag-preview.png') });
  await page.mouse.up();
  assert.equal(await view.locator('.session-drag-preview').count(), 0);
  await page.waitForTimeout(250);
  assert.deepEqual(await view.locator('.session').evaluateAll(nodes => nodes.map(node => node.dataset.session)), [first.id, second.id]);
  assert.ok((await b.boundingBox()).y <= (await a.boundingBox()).y);
});

test('Apple touch terminal displays initial output and subsequent writes without WebGL', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t, { appleTouch: true });
  const session = await create('手机渲染验证');
  const card = view.locator(`[data-session="${session.id}"]`);
  await card.locator('.xterm-rows').filter({ hasText: 'READY' }).waitFor({ timeout: 5000 });
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'phone-output'), { owner, id: session.id });
  await card.locator('.xterm-rows').filter({ hasText: 'phone-output' }).waitFor({ timeout: 5000 });
  assert.equal(await card.locator('.xterm-screen canvas').count(), 0);
  assert.equal(alive(session.pid), true);
});

test('accelerated terminal survives GPU context loss without losing session output', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const session = await create('渲染验证');
  const card = view.locator(`[data-session="${session.id}"]`);
  const accelerated = await card.locator('.xterm-screen').evaluate(screen => {
    const context = [...screen.querySelectorAll('canvas')].map(canvas => canvas.getContext('webgl2')).find(Boolean);
    context?.getExtension('WEBGL_lose_context').loseContext();
    return !!context;
  });
  assert.equal(accelerated, true, 'terminal uses the accelerated renderer');
  await card.locator('.xterm-rows').waitFor();
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'after-loss'), { owner, id: session.id });
  await output(page, session.id, 'INPUT="after-loss"');
  await card.locator('.xterm-rows').filter({ hasText: 'after-loss' }).waitFor();
  assert.equal(alive(session.pid), true);
});


test('three terminals with colored Chinese history stay responsive during scrolling', { timeout: 90000 }, async t => {
  const { page, view, create } = await setup(t);
  const sessions = [];
  for (const name of ['压力一', '压力二', '压力三']) {
    const session = await create(name);
    sessions.push(session);
    await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'rich-history'), { owner, id: session.id });
    await output(page, session.id, 'row 2999');
  }
  await page.waitForTimeout(1800);
  const card = view.locator(`[data-session="${sessions[0].id}"]`);
  await card.scrollIntoViewIfNeeded();
  const slider = card.locator('.xterm-scrollable-element .scrollbar.vertical .slider');
  const before = await slider.getAttribute('style');
  await card.evaluate(() => {
    window.scrollProbe = true;
    window.frameTimes = [];
    let last = performance.now();
    const sample = now => {
      window.frameTimes.push(now - last);
      last = now;
      if (window.scrollProbe) { requestAnimationFrame(sample); }
    };
    requestAnimationFrame(sample);
  });
  const box = await card.locator('.xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 48; i++) {
    await page.mouse.wheel(0, -110);
    await page.waitForTimeout(16);
  }
  const times = await card.evaluate(() => { window.scrollProbe = false; return window.frameTimes.slice(2); });
  const sorted = times.sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * .95)];
  t.diagnostic(`three terminals, 9000 colored Chinese rows: frames=${sorted.length}, p95=${p95.toFixed(1)}ms, max=${sorted.at(-1).toFixed(1)}ms`);
  assert.ok(p95 < 50, '95% of scrolling frames complete within 50ms');
  assert.notEqual(await slider.getAttribute('style'), before);
  await card.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('r');
  await output(page, sessions[0].id, 'INPUT="r"');
  await page.screenshot({ path: resolve('.test-results/agent-colored-history-scroll.png') });
});
