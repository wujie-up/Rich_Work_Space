import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { temporaryStore } from '../../../../desk/test/helpers.js';
import { PluginChannels } from '../../../../desk/src/main/common/plugin-channels.js';
import { Sessions } from '../../src/main/common/sessions.js';
import { SessionMessages } from '../../src/main/common/session-messages.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('production terminal scrolling preserves idle delivery, busy FIFO and native draft protection', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-delivery-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import '@xterm/xterm/css/xterm.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    window.postMessage = () => {};
    api.sessions.attach = (owner, id) => window.attach(id);
    api.sessions.resize = async () => {};
    api.sessions.write = (owner, id, data) => window.input(id, data);
    api.sessions.composer = (owner, id, report) => window.composer(id, report);
    let output;
    api.events.output = callback => { output = callback; return () => { output = null; }; };
    window.sendOutput = event => output(event);
    window.mount = () => {
      const session = { pluginId: 'one', id: 'b', adapterId: 'codex', cwd: '/project' };
      window.view = mountTerminal(document.querySelector('main'), { session, protocol: 'codex' });
    };
    window.ready = true;`, resolveDir: repository, sourcefile: 'session-delivery-fixture.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><style>main{height:600px}.terminal-screen{height:100%}</style><main></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const storage = await temporaryStore(t);
  const broker = new PluginChannels({ storage, usable: () => true });
  const source = { id: 'one', instanceId: 'delivery-fixture' };
  const channels = Object.fromEntries(['register', 'unregister', 'list', 'send', 'inbox', 'claim', 'settle']
    .map(action => [action, input => broker.request(source, action, input)]));
  const writes = [];
  const sessions = new Sessions({ storage });
  for (const id of ['a', 'b']) {
    sessions.active.set(id, { id, groupId: 'team', pluginId: 'one', adapterId: 'codex', protocol: 'managed-terminal', activity: 'done', sequence: 0,
      terminal: { write: data => writes.push(data) } });
  }
  const b = sessions.active.get('b');
  const manager = new SessionMessages({ pluginId: 'one', sessions, channels });
  sessions.messages = manager;
  t.after(() => manager.stop());
  const prompt = text => '\x1b[H\x1b[2J\x1b[3;1H› ' + text + '\r\nGPT-6.1-sol · /project\r\n? for shortcuts'
    + `\x1b[3;${3 + text.length}H`;
  b.output = prompt('') + '\x1b[?1000h\x1b[?1006h';
  await page.exposeFunction('attach', id => sessions.attach('one', id));
  await page.exposeFunction('input', (id, data) => sessions.write('one', id, data));
  await page.exposeFunction('composer', (id, report) => manager.composer(id, report));
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.mount());
  const until = async check => {
    const deadline = Date.now() + 5000;
    while (!await check()) {
      assert.ok(Date.now() < deadline, `delivery did not settle: ${manager.reason(b)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const paint = text => page.evaluate(event => window.sendOutput(event), { pluginId: 'one', sessionId: 'b',
    sequence: ++b.sequence, inputRevision: b.inputRevision || 0, data: prompt(text) });
  await until(() => !manager.reason(b));
  const screen = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(screen.x + 40, screen.y + 40);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, 100);
  await page.mouse.click(screen.x + 40, screen.y + 40);
  await until(() => writes.some(data => data.startsWith('\x1b[<65;')));
  assert.equal(b.pendingUserInput, undefined);
  assert.equal(b.inputRevision, undefined);
  await until(() => !manager.reason(b));
  const send = (requestId, text) => manager.call('a', 'agent_session_send', { targetId: 'b', requestId, text });
  const delivered = () => writes.filter(data => data.startsWith('\x1b[200~'));
  await send('idle', 'idle peer');
  await until(() => delivered().length === 1);
  await send('busy', 'second peer');
  await manager.flush();
  assert.equal(delivered().length, 1);
  b.activity = 'done';
  await paint('');
  await until(() => delivered().length === 2);
  assert.match(delivered()[1], /second peer/);
  b.activity = 'done';
  await page.evaluate(() => window.view.terminal.input('draft', true));
  await until(() => !!b.pendingUserInput);
  await paint('draft');
  await until(() => b.pendingUserInput?.observedDraft);
  await send('draft', 'after draft cleared');
  await manager.flush();
  assert.equal(delivered().length, 2);
  await page.evaluate(() => window.view.terminal.input('\x15', true));
  await until(() => writes.at(-1) === '\x15');
  await paint('');
  await until(() => delivered().length === 3);
  assert.match(delivered()[2], /after draft cleared/);
  await page.evaluate(() => window.view.dispose());
});
