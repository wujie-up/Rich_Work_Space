import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('full-screen terminal keeps up with consecutive native scroll redraws', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-scroll-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    // Keep the redraw workload at its original column count, independently of the user's display default.
    document.documentElement.style.setProperty('--agent-font-size', '11px');
    window.postMessage = () => {};
    api.sessions.attach = async () => ({ data: '', sequence: 0 });
    api.sessions.resize = async () => {};
    window.inputs = [];
    api.sessions.write = async (owner, id, data) => { window.inputs.push(data); };
    let output;
    api.events.output = callback => { output = callback; return () => { output = null; }; };
    const session = { pluginId: 'ai-agent-sessions', id: 'scroll-fixture', adapterId: 'codex', cwd: '/project' };
    window.sendOutput = (sequence, data) => output({ ...session, sessionId: session.id, sequence, data });
    window.view = mountTerminal(document.querySelector('.terminal-mount'), { session, protocol: 'codex' });
    window.scrollRedraws = async () => {
      const terminal = window.view.terminal;
      const line = Array.from({ length: 12 }, () => '\\x1b[38;2;100;120;140m' + 'x'.repeat(Math.floor(terminal.cols / 12) - 1) + '\\x1b[0m').join('');
      let parsedAt;
      const parsed = terminal.onWriteParsed(() => {
        if (terminal.buffer.active.getLine(terminal.rows - 1)?.translateToString(true) === 'DONE 90') {
          parsedAt = performance.now();
        }
      });
      const frame = number => '\\x1b[?2026h\\x1b[H' + 'FRAME ' + number + '\\x1b[K\\r\\n'
        + Array.from({ length: terminal.rows - 2 }, (_, row) => line + row + '\\x1b[K').join('\\r\\n')
        + '\\x1b[' + terminal.rows + ';1HDONE ' + number + '\\x1b[K\\x1b[?2026l';
      const start = performance.now();
      const gaps = [];
      let previous = start;
      for (let sequence = 1; sequence <= 90; sequence++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        gaps.push(now - previous);
        previous = now;
        window.sendOutput(sequence, frame(sequence));
      }
      const stoppedAt = performance.now();
      while (!parsedAt && performance.now() - stoppedAt < 4500) { await new Promise(requestAnimationFrame); }
      parsed.dispose();
      gaps.sort((a, b) => a - b);
      return { cols: terminal.cols, rows: terminal.rows, bytesPerRedraw: frame(90).length,
        scrollMs: stoppedAt - start, trailingMs: parsedAt ? parsedAt - stoppedAt : 4500, p95FrameMs: gaps[Math.floor(gaps.length * .95)] };
    };
    window.ready = true;`, resolveDir: repository, sourcefile: 'terminal-scroll-fixture.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main class="windows arranged"><article class="session maximized"><div class="session-content"><div class="terminal-mount"></div></div></article></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1080));
  await page.waitForFunction(() => window.ready && window.view.terminal.cols > 250 && !window.view.terminal.options.disableStdin);
  const measurements = await page.evaluate(() => window.scrollRedraws());
  t.diagnostic(JSON.stringify(measurements));
  assert.ok(measurements.trailingMs < 500, `scroll redraws should settle promptly after scrolling stops: ${JSON.stringify(measurements)}`);
  assert.ok(measurements.p95FrameMs < 50, `parsing should yield time for browser frames: ${JSON.stringify(measurements)}`);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('reply');
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => window.inputs.join('')), 'reply\x1b');
  // Native mouse mode must still send both scroll directions to the CLI.
  await page.evaluate(() => new Promise(resolve => window.view.terminal.write('\x1b[?1000h\x1b[?1006h', resolve)));
  const screen = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(() => window.inputs.some(data => data.startsWith('\x1b[<64;')));
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => window.inputs.some(data => data.startsWith('\x1b[<65;')));
  // Local history scrolling must not be converted into input when native mouse mode is off.
  await page.evaluate(() => new Promise(resolve => window.view.terminal.write('\x1b[?1000l\x1b[?1006l'
    + Array.from({ length: 3000 }, (_, row) => 'history ' + row + '\r\n').join(''), resolve)));
  const inputs = await page.evaluate(() => window.inputs.length);
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => window.view.terminal.buffer.active.viewportY < window.view.terminal.buffer.active.baseY);
  assert.equal(await page.evaluate(() => window.inputs.length), inputs);
  // Chunk boundaries must retain Unicode and output order; stale events must not reappear.
  await page.evaluate(() => {
    window.sendOutput(91, '\x1b[H\x1b[2J' + '字😀'.repeat(16000));
    window.sendOutput(92, '\r\nTAIL-END');
    window.sendOutput(91, '\r\nSTALE');
  });
  await page.waitForFunction(() => {
    const buffer = window.view.terminal.buffer.active;
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) === 'TAIL-END';
  });
  assert.equal(await page.evaluate(() => {
    const buffer = window.view.terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true))
      .some(line => line.includes('\ufffd') || line.includes('STALE'));
  }), false);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.sendOutput(93, 'pending output'.repeat(100000));
    window.view.dispose();
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(errors, []);
});
