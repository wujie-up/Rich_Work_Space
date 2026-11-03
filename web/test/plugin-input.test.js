import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

for (const engine of [chromium, webkit]) {
test(`Web input adapter supports phone swipes without plugin APIs (${engine.name()})`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import '@xterm/xterm/css/xterm.css';
    import { Terminal } from '@xterm/xterm';
    import { FitAddon } from '@xterm/addon-fit';
    import './web/src/browser/plugin-input.js';
    window.terminal = new Terminal({ scrollback: 3500 });
    const fit = new FitAddon(); terminal.loadAddon(fit);
    terminal.open(document.querySelector('#terminal')); fit.fit();
    window.inputs = []; terminal.onData(data => inputs.push(data));
  `, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, format: 'esm', outfile: join(directory, 'app.js') });
  await writeFile(join(directory, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><div id="terminal" style="height:600px"></div><div style="height:1200px">ordinary page</div><script type="module" src="app.js"></script>');
  const server = createServer(async (request, response) => {
    const file = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (!['index.html', 'app.js', 'app.css'].includes(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(join(directory, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await engine.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.terminal?.rows > 5);
  const write = data => page.evaluate(data => new Promise(resolve => terminal.write(data, resolve)), data);
  const cdp = engine === chromium ? await page.context().newCDPSession(page) : null;
  const touch = async (type, touchPoints) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      return;
    }
    // WebKit has no CDP touch injection; exercise event routing with equivalent touch lists.
    await page.evaluate(({ type, touchPoints }) => {
      const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touchPoints.map(point => ({ identifier: 0, clientX: point.x, clientY: point.y })) });
      document.querySelector('.xterm-screen').dispatchEvent(event);
    }, { type, touchPoints });
  };
  const swipe = async direction => {
    const bounds = await page.locator('.xterm-screen').boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await touch('touchStart', [{ x, y }]);
    for (let step = 1; step <= 6; step++) {
      await touch('touchMove', [{ x, y: y + direction * step * 15 }]);
    }
    await touch('touchEnd', []);
  };
  await write(Array.from({ length: 300 }, (_, i) => `history ${i}\r\n`).join(''));
  await swipe(1);
  await page.waitForFunction(() => terminal.buffer.active.viewportY < terminal.buffer.active.baseY, null, { timeout: 2000 });
  const earlier = await page.evaluate(() => terminal.buffer.active.viewportY);
  await swipe(-1);
  await page.waitForFunction(y => terminal.buffer.active.viewportY > y, earlier);
  assert.deepEqual(await page.evaluate(() => inputs), []);
  await write('\x1b[?1000h\x1b[?1006h');
  await swipe(1);
  await page.waitForFunction(() => inputs.some(data => data.startsWith('\x1b[<64;')));
  await swipe(-1);
  await page.waitForFunction(() => inputs.some(data => data.startsWith('\x1b[<65;')));
  await page.evaluate(() => { inputs.length = 0; });
  await touch('touchStart', [{ x: 50, y: 50 }]);
  await touch('touchEnd', []);
  await touch('touchStart', [{ x: 50, y: 50 }]);
  await touch('touchCancel', []);
  await touch('touchStart', [{ x: 50, y: 50 }, { x: 100, y: 50 }]);
  await touch('touchMove', [{ x: 50, y: 80 }, { x: 100, y: 80 }]);
  await touch('touchEnd', []);
  assert.equal(await page.evaluate(() => inputs.some(data => /^\x1b\[<6[45];/.test(data))), false);
  await write('\x1b[?1000l\x1b[?1006l\x1b[?1049h');
  await swipe(1);
  await page.waitForFunction(() => inputs.some(data => /\x1b(?:\[|O)A/.test(data)));
  await swipe(-1);
  await page.waitForFunction(() => inputs.some(data => /\x1b(?:\[|O)B/.test(data)));
  assert.equal(await page.evaluate(() => scrollY), 0, 'terminal gestures must not scroll the containing page');
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 50, y: 710 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 50, y: 640 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.getByText('ordinary page').scrollIntoViewIfNeeded();
  }
  await page.waitForFunction(() => scrollY > 0);
});
}
