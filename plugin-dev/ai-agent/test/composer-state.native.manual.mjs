// Usage: node test/composer-state.native.manual.mjs <managed-codex-binary> [managed-claude-binary]
// Native engines run only in disposable homes with a fake loopback provider and no user credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { PluginChannels } from '../../../desk/src/main/common/plugin-channels.js';
import { Sessions } from '../src/main/common/sessions.js';
import { SessionMessages } from '../src/main/common/session-messages.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-composer-native-')));
let browser;
let requests = 0;
const provider = createServer((request, response) => {
  if (/\/(responses|messages)(?:\?|$)/.test(request.url)) { requests++; }
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: 'api_error', message: 'Disposable fixture: no model' } }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${provider.address().port}`;
try {
  await build({ stdin: { contents: `import { Terminal } from '@xterm/xterm';
    import { emptyComposer, occupiedComposer } from './plugin-dev/ai-agent/src/shared/composer-state.js';
    window.terminal = new Terminal({ cols: 110, rows: 28 });
    terminal.open(document.querySelector('main'));
    terminal.onData(data => window.nativeInput(data));
    window.write = data => new Promise(resolve => terminal.write(data, resolve));
    window.inspect = () => { const b = terminal.buffer.active; const l = b.getLine(b.baseY + b.cursorY);
      return { empty: emptyComposer(b), occupied: occupiedComposer(b), cursor: b.cursorX, line: l.translateToString(true),
        cells: Array.from({length: 8}, (_,i) => ({text:l.getCell(i)?.getChars(), dim:l.getCell(i)?.isDim()})),
        screen: Array.from({length:b.length}, (_,i)=>b.getLine(i).translateToString(true)).join('\\n') }; };`,
    resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), sourcefile: 'composer-fixture.js' },
    bundle: true, format: 'esm', outfile: join(root, 'app.js') });
  await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="UTF-8"><main></main><script type="module" src="app.js"></script>');
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  for (const [index, path] of process.argv.slice(2).entries()) {
    const engine = index ? 'claude' : 'codex';
    const home = join(root, engine);
    await mkdir(join(home, 'codex'), { recursive: true });
    await writeFile(join(home, 'codex/config.toml'), 'model_provider="fixture"\nmodel="fixture-model"\n'
      + `[model_providers.fixture]\nname="Fixture"\nbase_url="${baseUrl}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
    await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      projects: { [home]: { hasTrustDialogAccepted: true } } }));
    const page = await browser.newPage();
    const sessions = new Sessions({ storage: new Storage(join(home, 'store')) });
    const source = { id: 'fixture', instanceId: engine };
    const broker = new PluginChannels({ storage: sessions.storage, usable: () => true });
    const channels = Object.fromEntries(['register', 'unregister', 'list', 'send', 'inbox', 'claim', 'settle']
      .map(action => [action, input => broker.request(source, action, input)]));
    const manager = new SessionMessages({ pluginId: 'fixture', sessions, channels });
    sessions.messages = manager;
    const replies = [];
    await page.exposeFunction('nativeInput', data => {
      replies.push(data);
      return sessions.write('fixture', 'recipient', data);
    });
    await page.goto(`file://${join(root, 'index.html')}`);
    await page.waitForFunction(() => window.write);
    const child = pty.spawn(resolve(path), engine === 'codex'
      ? ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'] : ['--model', 'fixture', '--permission-mode', 'default'], {
      cwd: home, cols: 110, rows: 28, env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, 'codex'),
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'fixture-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });
    const exited = new Promise(resolve => child.onExit(resolve));
    const recipient = { id: 'recipient', pluginId: 'fixture', adapterId: engine, protocol: 'managed-terminal',
      activity: 'done', name: engine, sequence: 0, terminal: child };
    sessions.active.set(recipient.id, recipient);
    sessions.active.set('sender', { ...recipient, id: 'sender', activity: 'working' });
    let version = 0;
    const report = state => manager.composer(recipient.id, { clientId: 'native', version: ++version,
      sequence: recipient.sequence, inputRevision: recipient.inputRevision || 0,
      empty: state.empty, nativeEmpty: state.empty, nativeDraft: state.occupied });
    let writing = Promise.resolve();
    child.onData(data => {
      const sequence = ++recipient.sequence;
      writing = writing.then(async () => {
        await page.evaluate(data => window.write(data), data);
        if (sequence === recipient.sequence) { report(await page.evaluate(() => window.inspect())); }
      });
      if (data.includes('\x1b]10;?')) { sessions.write('fixture', recipient.id, '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'); }
      if (data.includes('\x1b]11;?')) { sessions.write('fixture', recipient.id, '\x1b]11;rgb:2020/2222/2727\x1b\\'); }
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 4500));
      await writing;
      let state = await page.evaluate(() => window.inspect());
      if (engine === 'claude' && state.screen.includes('Yes, I trust this folder')) {
        assert.equal(state.empty, false, 'trust confirmation cannot accept peer messages');
        child.write('\x1b[B\r');
        await new Promise(resolve => setTimeout(resolve, 3500));
        await writing;
        state = await page.evaluate(() => window.inspect());
      }
      if (engine === 'claude' && state.screen.includes('Do you want to use this API key?')) {
        assert.equal(state.empty, false, 'API key confirmation cannot accept peer messages');
        child.write('\x1b[A\r');
        await new Promise(resolve => setTimeout(resolve, 3500));
        await writing;
        state = await page.evaluate(() => window.inspect());
      }
      assert.equal(state.empty, true, `${engine} idle composer is recognized`);
      assert.equal(recipient.pendingUserInput, undefined, `${engine} negotiation cannot create a phantom draft: ${JSON.stringify(replies)}`);
      await sessions.write('fixture', recipient.id, 'draft');
      await new Promise(resolve => setTimeout(resolve, 200));
      await writing;
      state = await page.evaluate(() => window.inspect());
      assert.equal(state.empty, false, `${engine} native draft stays protected`);
      assert.equal(state.occupied, true, `${engine} native prompt acknowledges the draft`);
      report(state);
      console.log(`${engine}: empty and draft checks passed`);
      const message = await manager.call('sender', 'agent_session_send',
        { targetId: recipient.id, requestId: 'native-peer', text: 'Please review this disposable test message.' });
      await manager.flush();
      assert.equal((await channels.inbox({ endpointId: recipient.id, messageId: message.messageId }))[0].status, 'pending');
      const before = requests;
      await sessions.write('fixture', recipient.id, '\x15');
      await new Promise(resolve => setTimeout(resolve, 400));
      await writing;
      report(await page.evaluate(() => window.inspect()));
      await manager.flush();
      for (let attempt = 0; requests === before && attempt < 80; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(requests > before, `${engine} bracketed peer paste and Enter must reach isolated provider`);
      assert.equal((await channels.inbox({ endpointId: recipient.id, messageId: message.messageId }))[0].status, 'delivered');
      console.log(`${engine}: queued message automatically submitted to fake provider after native draft clear`);
    } finally {
      await manager.stop();
      child.kill();
      await exited;
      await writing;
      await page.close();
    }
  }
} finally {
  await browser?.close();
  // The managed Codex daemon can detach from the PTY; reclaim only processes in this disposable home.
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of processes.split('\n')) {
    const match = line.trim().match(/^(\d+) (.*)$/);
    if (match?.[2].startsWith(`${root}/`)) { process.kill(Number(match[1]), 'SIGKILL'); }
  }
  await new Promise(resolve => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
