import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const adapter = { id: 'test', capabilities: {}, buildLaunch: () => ({ command: 'test', args: [], env: {} }) };
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter,
    guard: (_id, work) => work(), processControl: async (s) => s.terminal.kill() });
  return { storage, sessions, pty };
}

test('file references belong to the requesting session and resolve against its working directory', async t => {
  const { storage, sessions } = await setup(t);
  const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root });
  await writeFile(`${storage.root}/notes.md`, 'context');
  await assert.rejects(sessions.fileReferences('two', record.id, ['./notes.md']), { code: 'SESSION_NOT_FOUND' });
  assert.deepEqual(await sessions.fileReferences('one', record.id, ['./notes.md']),
    [{ path: `${record.cwd}/notes.md`, name: 'notes.md' }]);
  await sessions.archive('one', record.id);
  await assert.rejects(sessions.fileReferences('one', record.id, ['./notes.md']), { code: 'SESSION_NOT_FOUND' });
});

test('Codex receives the theme palette without an attached view or user activity', async t => {
  const { storage, sessions, pty } = await setup(t);
  sessions.setTheme('one', 'light');
  const record = await sessions.create('one', { adapterId: 'codex', cwd: storage.root });
  const replies = [];
  pty.terminals[0].write = data => replies.push(data);
  const session = sessions.get('one', record.id);
  pty.terminals[0].data('\x1b]10;?\x1b\\\x1b]11;?\x1b\\');
  assert.deepEqual(replies, ['\x1b]10;rgb:2828/2c2c/3535\x1b\\', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\']);
  assert.equal(session.lastInputAt, undefined);
  assert.equal(session.activity, 'unknown');
  assert.equal(session.sequence, 0);
  assert.equal(sessions.attach('one', record.id).data, '');
  await sessions.archive('one', record.id);
});

test('history excludes restored windows until archived again, preserving replay and unrelated sessions', async t => {
  const { storage, sessions, pty } = await setup(t);
  const original = await sessions.create('one', { adapterId: 'test', cwd: storage.root, name: 'same name' });
  pty.terminals[0].data('saved replay');
  await sessions.archive('one', original.id);
  const peer = await sessions.create('one', { adapterId: 'test', cwd: storage.root, name: original.name });
  assert.deepEqual(sessions.list('one').archives.map(session => session.id), [original.id]);
  const events = [];
  sessions.emit = (_channel, data) => events.push(data);
  const restored = await sessions.restore('one', original.id, randomUUID());
  assert.deepEqual(sessions.list('one').archives, []);
  assert.deepEqual(events.at(-1).archives, []);
  assert.equal((await sessions.readArchive('one', original.id)).output, 'saved replay');
  assert.equal(sessions.list('one').sessions.length, 2);
  // A failed CLI still owns its visible window and must not reappear as a second history entry.
  pty.terminals[2].exit({ exitCode: 1 });
  await sessions.get('one', restored.id).exitCleanup;
  assert.deepEqual(sessions.list('one').archives, []);
  await sessions.archive('one', restored.id);
  assert.deepEqual(sessions.list('one').archives.map(session => session.id), [original.id]);
  assert.deepEqual(events.at(-1).archives.map(session => session.id), [original.id]);
  assert.equal((await sessions.readArchive('one', original.id)).output, 'saved replay');
  await sessions.archive('one', peer.id);
});

test('abnormal exit retains the terminal, error and window until explicit close', async t => {
  const { storage, sessions, pty } = await setup(t);
  const windowId = randomUUID();
  const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root, windowId, name: '网络故障' });
  const failure = 'Error: invalid model configuration';
  pty.terminals[0].data(failure);
  pty.terminals[0].exit({ exitCode: 1 });
  await new Promise(setImmediate);
  const current = sessions.list('one').sessions[0];
  assert.ok(current, 'failed CLI must remain visible');
  await sessions.active.get(record.id).exitCleanup;
  assert.equal(current.exited, true);
  assert.equal(current.windowId, windowId);
  assert.equal(current.error.code, 'SESSION_EXITED');
  assert.equal(sessions.attach('one', record.id).data, failure);
  assert.equal(sessions.list('one').archives.length, 0);
  assert.equal((await storage.readJson(sessions.key(current))).output, failure);
  await sessions.archive('one', record.id);
  assert.equal((await sessions.readArchive('one', record.id)).output, failure);
});

test('retry coalesces requests, resumes known context and preserves the failed session when launch fails', async t => {
  const { storage, sessions, pty } = await setup(t);
  const launches = [];
  sessions.adapter = () => ({ capabilities: { restore: true }, buildLaunch: input => {
    launches.push(input);
    return { command: 'test', args: [], env: {} };
  } });
  const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root, windowId: randomUUID(), name: '保留名称' });
  sessions.active.get(record.id).contextId = 'known-context';
  pty.terminals[0].data('previous output');
  pty.terminals[0].exit({ exitCode: 1 });
  await sessions.active.get(record.id)?.exitCleanup;
  const spawn = sessions.spawn;
  sessions.spawn = () => { throw Error('offline engine missing'); };
  await assert.rejects(sessions.restore('one', record.id), { code: 'SESSION_LAUNCH_FAILED' });
  assert.equal(sessions.get('one', record.id).output, 'previous output');
  sessions.spawn = spawn;
  const [first, second] = await Promise.all([sessions.restore('one', record.id), sessions.restore('one', record.id)]);
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, record.id);
  assert.equal(first.windowId, record.windowId);
  assert.equal(first.name, record.name);
  assert.equal(first.contextId, 'known-context');
  assert.equal(launches.at(-1).mode, 'resume');
  assert.equal(sessions.list('one').sessions.length, 1);
  assert.equal((await sessions.readArchive('one', record.id)).output, 'previous output');
  await sessions.archive('one', first.id);
});

test('retry without native context starts fresh, while normal exits still archive', async t => {
  const { storage, sessions, pty } = await setup(t);
  const launches = [];
  sessions.adapter = () => ({ capabilities: {}, buildLaunch: input => {
    launches.push(input);
    return { command: 'test', args: [], env: {} };
  } });
  const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root });
  pty.terminals[0].data('do not resend this input');
  pty.terminals[0].exit({ exitCode: 1 });
  await sessions.active.get(record.id)?.exitCleanup;
  const retried = await sessions.restore('one', record.id);
  assert.equal(launches.at(-1).mode, undefined);
  assert.equal(sessions.attach('one', retried.id).data, 'do not resend this input');
  pty.terminals[1].exit({ exitCode: 0 });
  await sessions.active.get(retried.id)?.closing;
  assert.equal(sessions.list('one').sessions.length, 0);
  assert.equal(sessions.list('one').archives.length, 1);
  assert.equal((await sessions.readArchive('one', record.id)).output, 'do not resend this input');
});

test('a window interrupted immediately after creation restores without output or a native context', async t => {
  const { storage, sessions } = await setup(t);
  const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root, windowId: randomUUID(), name: '刚创建的窗口' });
  const launches = [];
  const pty = fakePty();
  const restarted = new Sessions({ storage, spawn: pty.spawn, guard: (_id, work) => work(),
    processControl: async session => session.terminal.kill(), adapter: () => ({ capabilities: { restore: true }, buildLaunch: input => {
      launches.push(input);
      assert.equal(input.mode, undefined, 'a missing native context must not be passed to CLI resume');
      return { command: 'test', args: [], env: {} };
    } }) });
  await restarted.loadPlugin('one');
  assert.equal(restarted.list('one').archives[0].reason, 'interrupted');
  const restored = await restarted.restore('one', record.id);
  assert.equal(launches.length, 1);
  assert.equal(restored.windowId, record.windowId);
  assert.equal(restored.name, '刚创建的窗口');
  assert.equal(restored.cwd, record.cwd);
  assert.equal(restored.restoredFrom, record.id);
  assert.equal(restarted.attach('one', restored.id).data, '');
  assert.equal((await restarted.restore('one', record.id)).id, restored.id);
  await restarted.archive('one', restored.id);
  await sessions.archive('one', record.id);
});

for (const [capabilities, contextId, mode] of [[{ restore: true }, undefined, undefined], [{ restore: false }, undefined, undefined],
  [{ restore: true }, 'saved-context', 'resume'], [{ restore: false }, 'saved-context', undefined]]) {
  test(`archived sessions restore configuration and replay with native restore=${capabilities.restore}, context=${contextId}`, async t => {
    const { storage, sessions, pty } = await setup(t);
    const launches = [];
    const snapshot = { model: 'saved-model' };
    sessions.adapter = () => ({ capabilities, buildLaunch: input => {
      launches.push(input);
      return { command: 'test', args: [], env: {}, runtimeId: 'saved-runtime', profileId: 'saved-profile', launchSettings: snapshot };
    } });
    const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root, name: '归档窗口', permission: 'read-only', contextId });
    pty.terminals[0].data('saved output, never replay as input');
    await sessions.archive('one', record.id);
    const windowId = randomUUID();
    const restored = await sessions.restore('one', record.id, windowId);
    assert.equal(launches.at(-1).mode, mode);
    assert.equal(launches.at(-1).contextId, mode ? 'saved-context' : undefined);
    assert.equal(launches.at(-1).permission, 'read-only');
    assert.equal(launches.at(-1).runtimeId, 'saved-runtime');
    assert.equal(launches.at(-1).profileId, 'saved-profile');
    assert.deepEqual(launches.at(-1).launchSettings, { model: 'saved-model' });
    assert.equal(restored.windowId, windowId);
    assert.equal(restored.name, '归档窗口');
    assert.equal(sessions.attach('one', restored.id).data, 'saved output, never replay as input');
    await sessions.archive('one', restored.id);
  });
}

test('sessions can launch more than twelve concurrent sessions', async (t) => {
  const { storage, sessions } = await setup(t);
  const created = await Promise.all(Array.from({ length: 16 }, (_, index) => sessions.create('one',
    { adapterId: 'test', cwd: storage.root, name: `Agent ${index + 1}` })));
  assert.equal(sessions.list('one').sessions.length, 16);
  assert.equal(new Set(created.map(session => session.id)).size, 16);
  await Promise.all(created.map(session => sessions.archive('one', session.id)));
});

test('clipboard images save in ordered chunks under the owning session and reject invalid input', async (t) => {
  const { storage, sessions } = await setup(t);
  const session = await sessions.create('one', { adapterId: 'test', cwd: storage.root });
  const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(800000, 42)]);
  const upload = { id: randomUUID(), type: 'image/png', offset: 0, data: image.subarray(0, 262144).toString('base64') };
  await assert.rejects(sessions.saveImage('two', session.id, upload), { code: 'SESSION_NOT_FOUND' });
  assert.equal(await sessions.saveImage('one', session.id, upload), null);
  await assert.rejects(sessions.saveImage('one', session.id, { ...upload, offset: 1 }), { code: 'INVALID_ARGUMENT' });
  let path;
  for (let offset = 262144; offset < image.length; offset += 262144) {
    path = await sessions.saveImage('one', session.id, { ...upload, offset,
      data: image.subarray(offset, offset + 262144).toString('base64'), complete: offset + 262144 >= image.length });
  }
  assert.ok(path.startsWith(storage.root));
  assert.ok(path.includes(session.id));
  assert.deepEqual(await readFile(path), image);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(sessions.saveImage('one', session.id, { ...upload, id: '../escape' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(sessions.saveImage('one', session.id, { ...upload, id: randomUUID(), type: 'image/svg+xml' }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(sessions.saveImage('one', session.id, { ...upload, id: randomUUID(), data: 'bm90IGFuIGltYWdl' }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(sessions.saveImage('one', session.id, { ...upload, offset: 20 * 1024 * 1024 }),
    { code: 'INVALID_ARGUMENT' });
  const closing = sessions.archive('one', session.id);
  await assert.rejects(sessions.saveImage('one', session.id, upload), { code: 'SESSION_BUSY' });
  await closing;
  assert.deepEqual(await readFile(path), image, 'archived image paths must remain usable for history and restore');
});

test('owner required; archive concurrent calls share once; history survives load', async (t) => {
  const { storage, sessions } = await setup(t);
  const input = { adapterId: 'test', cwd: storage.root, name: '测试' };
  await assert.rejects(sessions.create(null, input));
  const a = await sessions.create('one', input);
  const b = await sessions.create('two', input);
  assert.notEqual(a.id, b.id);
  assert.throws(() => sessions.write('two', a.id, 'oops'), /归属/);
  sessions.write('one', a.id, 'hello 中文');
  const [first, second] = await Promise.all([sessions.archive('one', a.id), sessions.archive('one', a.id)]);
  assert.equal(first.id, second.id);
  assert.equal((await sessions.readArchive('one', a.id)).output, 'hello 中文');
  assert.equal(sessions.list('two').sessions.length, 1);
  await sessions.archive('two', b.id);
  const restarted = new Sessions({ storage });
  await restarted.loadPlugin('one');
  assert.equal(restarted.list('one').archives.length, 1);
  assert.equal(restarted.list('one').sessions.length, 0);
});

test('stop and archive failures stay visible and retry without losing records', async (t) => {
  const { storage, sessions } = await setup(t);
  const a = await sessions.create('one', { adapterId: 'test', cwd: storage.root, name: 'retry' });
  const stop = sessions.processControl;
  sessions.processControl = async () => { throw new Error('timeout'); };
  await assert.rejects(sessions.archive('one', a.id), { code: 'SESSION_STOP_FAILED' });
  assert.equal(sessions.list('one').sessions.length, 1);
  sessions.processControl = stop;
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw new Error('full disk'); };
  await assert.rejects(sessions.archive('one', a.id), { code: 'ARCHIVE_WRITE_FAILED' });
  assert.equal(sessions.list('one').sessions[0].exited, false, 'a failed close-intent write must not stop the process');
  storage.writeJson = write;
  await sessions.archive('one', a.id);
  assert.equal(sessions.list('one').archives.length, 1);
});

test('bounded unicode replay has ordered sequences and archived sessions reject rename while closing', async (t) => {
  const { storage, sessions, pty } = await setup(t);
  const a = await sessions.create('one', { adapterId: 'test', cwd: storage.root });
  pty.terminals[0].data('中'.repeat(800000));
  const snapshot = sessions.attach('one', a.id);
  assert.ok(Buffer.byteLength(snapshot.data) <= 2 * 1024 * 1024);
  assert.equal(snapshot.data.includes('\uFFFD'), false);
  assert.equal(snapshot.sequence, 1);
  pty.terminals[0].data('END');
  assert.equal(sessions.attach('one', a.id).sequence, 2);
  const closing = sessions.archive('one', a.id);
  await assert.rejects(sessions.rename('one', a.id, 'too late'), { code: 'SESSION_BUSY' });
  await closing;
  assert.equal((await sessions.readArchive('one', a.id)).lifecycle, 'archived');
});

test('managed terminal capture follows creation, window attachment and archive ownership', async t => {
  const { storage, sessions } = await setup(t);
  const windowId = randomUUID();
  const otherWindow = randomUUID();
  const launches = [];
  sessions.adapter = () => ({ capabilities: {}, buildLaunch: () => ({ command: 'test', args: ['original'], env: {}, isolated: true }) });
  sessions.capture = { prepare: async (record, launch) => {
    launches.push({ record, launch });
    return { key: 'http://127.0.0.1:1234/proxy', args: [...launch.args, 'capture-route'], env: { ROUTED: 'yes' } };
  } };
  let spawnArgs;
  const spawn = sessions.spawn;
  sessions.spawn = (...args) => { spawnArgs = args; return spawn(...args); };
  const record = await sessions.create('one', { adapterId: 'codex', cwd: storage.root, windowId });
  assert.equal(launches[0].record.windowId, windowId);
  assert.equal(launches[0].record.engineId, 'codex');
  assert.deepEqual(spawnArgs[1], ['original', 'capture-route']);
  assert.equal(spawnArgs[2].env.ROUTED, 'yes');
  assert.equal(sessions.active.get(record.id).captureKey, 'http://127.0.0.1:1234/proxy');
  await assert.rejects(sessions.attachWindow('two', record.id, otherWindow), /归属/);
  await sessions.attachWindow('one', record.id, otherWindow);
  await sessions.archive('one', record.id);
  assert.equal((await sessions.readArchive('one', record.id)).windowId, otherWindow);
});

test('explicit MCP reconnect refuses busy terminals, resumes native context and releases only its old relay', async t => {
  const { sessions, storage, pty } = await setup(t);
  const launches = [];
  const closed = [];
  sessions.adapter = () => ({ capabilities: { restore: true }, resolveContext: async session => session.contextId,
    buildLaunch: input => {
      launches.push(input);
      return { command: 'test', args: [], env: {}, mcpConnection: { close: async () => { closed.push(input.sessionId); } } };
    } });
  t.after(() => sessions.stopAndArchive('one', 'quit'));
  const created = await sessions.create('one', { adapterId: 'codex', cwd: storage.root, name: '数据库', contextId: 'native-123' });
  const peer = await sessions.create('one', { adapterId: 'codex', cwd: storage.root, contextId: 'peer' });
  const original = sessions.get('one', created.id);
  original.activity = 'running';
  await assert.rejects(sessions.reconnect('one', created.id), { code: 'SESSION_BUSY' });
  assert.equal(closed.length, 0);
  original.activity = 'idle';
  pty.terminals[0].data('history');
  const replacement = await sessions.reconnect('one', created.id);
  assert.notEqual(replacement.id, created.id);
  assert.equal(replacement.contextId, 'native-123');
  assert.equal(sessions.get('one', replacement.id).output, 'history');
  assert.equal(launches.at(-1).mode, 'resume');
  assert.equal(launches.at(-1).contextId, 'native-123');
  assert.deepEqual(closed, [created.id]);
  assert.ok(sessions.get('one', peer.id));
});

test('reconnect validates recovery before stopping the window and permits a proven empty context', async t => {
  const { sessions, storage, pty } = await setup(t);
  let recover = async () => { throw Object.assign(Error('missing context'), { code: 'CONTEXT_NOT_FOUND' }); };
  const launches = [];
  sessions.adapter = () => ({ capabilities: { restore: true }, resolveContext: async session => session.contextId,
    restoreContext: session => recover(session), buildLaunch: input => {
      launches.push(input);
      return { command: 'test', args: [], env: {} };
    } });
  t.after(() => sessions.stopAndArchive('one', 'quit'));
  const created = await sessions.create('one', { adapterId: 'codex', cwd: storage.root, contextId: 'temporary-id' });
  sessions.get('one', created.id).activity = 'idle';
  pty.terminals[0].data('retained output');
  await assert.rejects(sessions.reconnect('one', created.id), { code: 'CONTEXT_NOT_FOUND' });
  assert.equal(sessions.get('one', created.id).exited, false);
  assert.equal(sessions.list('one').archives.length, 0);
  recover = async () => undefined;
  const replacement = await sessions.reconnect('one', created.id);
  assert.equal(replacement.contextId, undefined);
  assert.equal(launches.at(-1).mode, undefined);
  assert.equal(sessions.attach('one', replacement.id).data, 'retained output');
});

test('terminal launch failure and abnormal exit release the session relay without persisting its credentials', async t => {
  const { sessions, storage, pty } = await setup(t);
  const closed = [];
  sessions.adapter = () => ({ capabilities: {}, buildLaunch: input => ({ command: 'test', args: [], env: {},
    mcpConnection: { token: 'private-relay-token', close: async () => closed.push(input.sessionId) } }) });
  const spawn = sessions.spawn;
  sessions.spawn = () => { throw Error('spawn failed'); };
  await assert.rejects(sessions.create('one', { adapterId: 'codex', cwd: storage.root }), { code: 'SESSION_LAUNCH_FAILED' });
  assert.equal(closed.length, 1);
  sessions.spawn = spawn;
  const created = await sessions.create('one', { adapterId: 'codex', cwd: storage.root });
  const saved = await storage.readJson(sessions.key(sessions.get('one', created.id)));
  assert.doesNotMatch(JSON.stringify(saved), /private-relay-token|mcpConnection/);
  pty.terminals[0].exit({ exitCode: 1 });
  await sessions.get('one', created.id).exitCleanup;
  assert.equal(closed.length, 2);
  assert.equal(closed.at(-1), created.id);
  await sessions.stopAndArchive('one', 'quit');
});

test('terminal submission refreshes MCP under the active RPC and preserves all PTY byte order', async t => {
  const { sessions, storage, pty } = await setup(t);
  const created = await sessions.create('one', { adapterId: 'codex', cwd: storage.root });
  const session = sessions.get('one', created.id);
  const bytes = [];
  pty.terminals[0].write = data => bytes.push(data);
  let release;
  let refreshes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  session.mcpConnection = { refresh: async () => { refreshes++; await gate; }, close: async () => {} };
  await sessions.write('one', created.id, 'first');
  assert.deepEqual(bytes, ['first']);
  assert.equal(refreshes, 0);
  const submit = sessions.write('one', created.id, '\r');
  const nextDraft = sessions.write('one', created.id, 'next draft');
  await new Promise(setImmediate);
  assert.equal(refreshes, 1);
  assert.deepEqual(bytes, ['first']);
  release();
  await Promise.all([submit, nextDraft]);
  assert.deepEqual(bytes, ['first', '\r', 'next draft']);
  await sessions.stopAndArchive('one', 'quit');
});

test('plugin shutdown blocks a queued Enter before waiting for task cleanup', async t => {
  const { sessions, storage, pty } = await setup(t);
  const created = await sessions.create('one', { adapterId: 'codex', cwd: storage.root });
  const session = sessions.get('one', created.id);
  const bytes = [];
  pty.terminals[0].write = data => bytes.push(data);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  session.mcpConnection = { refresh: async () => gate, close: async () => {} };
  const submit = sessions.write('one', created.id, '\r');
  const rejected = assert.rejects(submit, { code: 'SESSION_BUSY' });
  await new Promise(setImmediate);
  sessions.blockInput();
  release();
  await rejected;
  assert.deepEqual(bytes, []);
  await sessions.stopAndArchive('one', 'quit');
});


test('network bootstrap failure keeps a reconnectable session without a generic host error', async t => {
  const { storage, sessions, pty } = await setup(t);
  const events = [];
  sessions.emit = (type, data) => events.push({ type, data });
  const record = await sessions.create('one', { adapterId: 'test', cwd: storage.root });
  pty.terminals[0].data('\x1b[31mError: account/read failed during TUI bootstrap: workspace routing discovery ');
  pty.terminals[0].data('timed out (code -32603)\x1b[0m\r\n');
  pty.terminals[0].exit({ exitCode: 1 });
  await sessions.get('one', record.id).exitCleanup;
  const current = sessions.list('one').sessions[0];
  assert.equal(current.activity, 'offline');
  assert.equal(current.error.code, 'SESSION_OFFLINE');
  assert.equal(events.some(event => event.type === 'host.error'), false);
  assert.match((await storage.readJson(sessions.key(current))).output, /routing discovery/);
  assert.throws(() => sessions.write('one', record.id, 'draft'), { code: 'SESSION_BUSY' });
  const restored = await sessions.restore('one', record.id);
  // An old network diagnostic in replay must not classify a different failure on the new process.
  pty.terminals[1].data('Error: unauthorized (HTTP 401)');
  pty.terminals[1].exit({ exitCode: 1 });
  await sessions.get('one', restored.id).exitCleanup;
  assert.equal(sessions.get('one', restored.id).error.code, 'SESSION_EXITED');
  await sessions.archive('one', restored.id);
});
