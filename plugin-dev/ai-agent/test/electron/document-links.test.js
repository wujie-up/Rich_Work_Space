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

test('terminal document links retain full paths and cell ranges across wrapping and resizing', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-document-links-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import { Terminal } from '@xterm/xterm';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    window.postMessage = () => {};
    api.sessions.attach = async () => ({ data: '', sequence: 0 });
    api.sessions.resize = api.sessions.composer = async () => {};
    api.events.output = () => () => {};
    window.opens = [];
    api.host.openView = async (entry, context) => window.opens.push({ entry, context });
    const register = Terminal.prototype.registerLinkProvider;
    Terminal.prototype.registerLinkProvider = function(provider) {
      window.provider = provider;
      return register.call(this, provider);
    };
    window.view = mountTerminal(document.querySelector('main'), {
      session: { pluginId: 'ai-agent-sessions', id: 'document-links-fixture', cwd: '/project' }, protocol: 'codex'
    });
    window.ready = true;
  `, resolveDir: repository, sourcefile: 'document-links-fixture.js' }, bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main style="width:600px;height:500px"></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready && !window.view.terminal.options.disableStdin);
  // Let the initial container resize finish before explicitly sizing the test terminal.
  await page.waitForTimeout(150);
  const cases = [
    { text: '文档 [schema](/project/backend/shared/db-init/migrations/01-empty-schema.sql)', path: '/project/backend/shared/db-init/migrations/01-empty-schema.sql' },
    { text: '`docs/长目录/技术 方案.md:12:3`', path: 'docs/长目录/技术 方案.md' },
    { text: '😀 文档 [说明](docs/报告.md)', path: 'docs/报告.md' },
    { text: '[方案](docs/技术 方案.md)', path: 'docs/技术 方案.md' }
  ];
  for (const { text, path } of cases) {
    for (const cols of [50, 15, 7]) {
      const result = await page.evaluate(async ({ text, cols }) => {
        const terminal = window.view.terminal;
        terminal.reset();
        terminal.resize(cols, 30);
        await new Promise(resolve => terminal.write(text, resolve));
        // Reflow must preserve the same destination after a window size change.
        terminal.resize(cols + 1, 30);
        const rows = [];
        for (let row = 1; row <= terminal.buffer.active.cursorY + 1; row++) {
          const links = await new Promise(resolve => window.provider.provideLinks(row, resolve));
          for (const link of links) { await link.activate(); }
          rows.push(links.map(({ text, range }) => ({ text, range })));
        }
        return { rows, opens: window.opens.splice(0), cols: terminal.cols,
          lines: Array.from({ length: terminal.buffer.active.cursorY + 1 }, (_, row) => ({
            text: terminal.buffer.active.getLine(row).translateToString(true), wrapped: terminal.buffer.active.getLine(row).isWrapped
          })) };
      }, { text, cols });
      assert.ok(result.opens.length, `link missing: ${text}, columns=${cols}: ${JSON.stringify(result)}`);
      assert.ok(result.opens.every(open => open.context.path === path && open.context.cwd === '/project'), JSON.stringify(result));
      const links = result.rows.flat();
      assert.ok(links.every(link => link.text === text || link.text === text.slice(text.indexOf('['))), JSON.stringify(result));
      assert.ok(links.every(link => link.range.start.x >= 1 && link.range.end.x <= cols + 1), JSON.stringify(result));
    }
  }
  const hardBreak = await page.evaluate(async () => {
    const terminal = window.view.terminal;
    terminal.reset();
    terminal.resize(50, 30);
    await new Promise(resolve => terminal.write('docs/first.md\r\nsecond.txt', resolve));
    const links = await new Promise(resolve => window.provider.provideLinks(2, resolve));
    for (const link of links) { await link.activate(); }
    window.view.dispose();
    return window.opens.splice(0);
  });
  assert.deepEqual(hardBreak, [{ entry: 'text-document', context: { path: 'second.txt', cwd: '/project' } }]);
});
