import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

test('expanding cards keeps their visual order and pushes lower cards without replacing content', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-session-expansion-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import { sessionArrangement } from './plugin-dev/ai-agent/src/renderer/session-arrangement.js';
    const container = document.querySelector('.windows');
    window.layout = { positions: { first: { col: 0, row: 0 }, second: { col: 0, row: 2 }, third: { col: 0, row: 4 } } };
    const arrangement = sessionArrangement(container, window.layout, () => {}, 'ai-agent-sessions');
    for (const [id, label] of [['second', '资源监控'], ['third', 'saas问题排查'], ['first', '老系统问题排查']]) {
      const card = document.createElement('article');
      card.className = 'session collapsed';
      card.dataset.session = id;
      card.style.height = '405px';
      card.innerHTML = '<header class="session-header"><strong class="session-name"></strong><div class="card-actions"><button>展开</button></div></header>'
        + '<div class="session-content"><div class="terminal-mount">保留的会话内容</div></div><footer class="session-footer">工作目录</footer>';
      card.querySelector('strong').textContent = label;
      const button = card.querySelector('button');
      button.addEventListener('click', () => {
        const collapsed = card.classList.toggle('collapsed');
        button.textContent = collapsed ? '展开' : '折叠';
      });
      container.append(card);
      arrangement.bind(card, card.querySelector('header'));
    }
    arrangement.refresh();
    window.retained = document.querySelector('[data-session="first"] .terminal-mount');
  `, resolveDir: fileURLToPath(new URL('../../../../', import.meta.url)), sourcefile: 'session-expansion.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), `<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css">
    <main id="workspace"><div class="windows arranged"></div></main><script type="module" src="app.js"></script>`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/status-artwork.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const geometry = () => page.locator('.session').evaluateAll(nodes => Object.fromEntries(nodes.map(node => {
    const box = node.getBoundingClientRect();
    return [node.dataset.session, { top: box.top, bottom: box.bottom, left: box.left }];
  })));
  await page.waitForFunction(() => document.querySelectorAll('.session[style*="top"]').length === 3);
  const positions = await page.evaluate(() => JSON.stringify(window.layout.positions));
  const shots = resolve('plugin-dev/dist/verification/session-expansion');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [880, 450]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 660), width);
      await page.waitForFunction(() => document.querySelector('[data-session="third"]').offsetTop === 96);
      const before = await geometry();
      const first = page.locator('[data-session="first"]');
      await first.getByRole('button', { name: '展开', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-session="second"]').offsetTop >= 405);
      const expanded = await geometry();
      assert.equal(expanded.first.top, before.first.top);
      assert.equal(expanded.first.left, before.first.left);
      assert.ok(expanded.second.top > expanded.first.bottom);
      assert.ok(expanded.third.top > expanded.second.bottom);
      await page.screenshot({ path: join(shots, `${theme}-${width}-expanded.png`) });
      await first.getByRole('button', { name: '折叠', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-session="third"]').offsetTop === 96);
      assert.deepEqual(await geometry(), before);
      assert.equal(await page.evaluate(() => window.retained === document.querySelector('[data-session="first"] .terminal-mount')), true);
      assert.equal(await page.evaluate(() => JSON.stringify(window.layout.positions)), positions);
    }
  }
});
