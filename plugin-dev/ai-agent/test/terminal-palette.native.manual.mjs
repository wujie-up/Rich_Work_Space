// Usage: node test/terminal-palette.native.manual.mjs <managed-codex-binary>
// Exercises the actual CLI in disposable homes with an unauthenticated loopback provider; no user data is loaded.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import pty from 'node-pty';
import { chromium } from 'playwright';
import { TerminalPalette } from '../src/main/common/terminal-palette.js';

assert.ok(process.argv[2], 'provide the managed Codex binary');
const binary = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'agent-palette-native-'));
const outputDirectory = process.env.PALETTE_SCREENSHOTS || root;
await mkdir(outputDirectory, { recursive: true });
const outputs = {};
let browser;
try {
  for (const [theme, color] of [['light', '244;244;244'], ['dark', '58;60;64']]) {
    const home = join(root, theme);
    await mkdir(join(home, 'codex'), { recursive: true });
    await writeFile(join(home, 'codex/config.toml'), 'model_provider="fixture"\nmodel="fixture-model"\n'
      + '[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
    let output = '';
    const child = pty.spawn(binary, ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'], {
      cwd: home, cols: 110, rows: 28, env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, 'codex'),
        TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });
    const exited = new Promise(resolve => child.onExit(resolve));
    const palette = new TerminalPalette(() => theme, data => child.write(data));
    child.onData(data => {
      output += palette.consume(data);
      if (data.includes('\x1b[6n')) { child.write('\x1b[1;1R'); }
      if (data.includes('\x1b[c')) { child.write('\x1b[?1;2c'); }
    });
    try {
      const deadline = Date.now() + 6000;
      while (!output.includes('Ask Codex to do anything') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.ok(output.includes(`\x1b[48;2;${color}m`), `${theme} native input surface must be shaded`);
      assert.ok(output.includes('Ask Codex to do anything'), 'native composer is available');
      outputs[theme] = output;
    } finally {
      child.kill();
      await exited;
    }
  }
  await build({ stdin: { contents: `
    import '@xterm/xterm/css/xterm.css';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    window.mount = (theme, output) => {
      window.view?.dispose();
      document.documentElement.dataset.theme = theme;
      window.view = mountTerminal(document.querySelector('main'), { session: { id: 'native-palette', pluginId: 'fixture' },
        protocol: 'codex', replay: { output } });
      window.view.terminal.resize(110, 28);
    };
  `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), sourcefile: 'palette-fixture.js' },
  bundle: true, format: 'esm', outfile: join(root, 'app.js') });
  await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css">'
    + '<style>body{margin:0}main{width:760px;height:430px}html[data-theme=light]{background:#fff}html[data-theme=dark]{background:#202227}</style>'
    + '<main></main><script type="module" src="app.js"></script>');
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 760, height: 430 } });
  await page.goto(`file://${join(root, 'index.html')}`);
  await page.waitForFunction(() => window.mount);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(({ theme, output }) => window.mount(theme, output), { theme, output: outputs[theme] });
    await page.waitForFunction(() => {
      const buffer = window.view.terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true))
        .some(line => line.includes('Ask Codex to do anything'));
    });
    // Buffer parsing finishes before the WebGL renderer paints the next frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(outputDirectory, `${theme}.png`) });
  }
  console.log(JSON.stringify({ nativeComposer: 'passed', themes: ['light', 'dark'], credentials: 'isolated-empty', screenshots: outputDirectory }));
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
