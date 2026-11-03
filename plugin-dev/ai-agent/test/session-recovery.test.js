import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Sessions } from '../src/main/common/sessions.js';
import { recoverSessions, restoreWhenReady } from '../src/renderer/session-recovery.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const options = { storage, spawn: pty.spawn, guard: (_, work) => work(),
    adapter: () => ({ capabilities: { restore: true }, prepareActivity: async changed => {
      changed({ activity: 'idle', blocked: null });
    }, buildLaunch: () => ({ command: 'test', args: [], env: {}, isolated: true }) }),
    processControl: async session => session.terminal.kill(), deleteContext: async () => {} };
  const sessions = new Sessions(options);
  const instances = [sessions];
  const restart = async () => {
    const loaded = new Sessions(options);
    await loaded.loadPlugin('test');
    instances.push(loaded);
    return loaded;
  };
  t.after(async () => {
    for (const instance of instances) {
      for (const session of instance.active.values()) {
        clearTimeout(session.checkpoint);
        await session.outputWrite;
        await session.exitCleanup;
      }
    }
  });
  return { storage, sessions, pty, restart };
}

test('opening the plugin automatically restores interrupted and quit sessions, excluding manual archives and deletions', async t => {
  const { storage, sessions, pty, restart } = await setup(t);
  const create = name => sessions.create('test', { adapterId: 'codex', cwd: storage.root, name, windowId: randomUUID() });
  const manual = await create('manual archive');
  await sessions.archive('test', manual.id);
  const deleted = await create('manual delete');
  sessions.get('test', deleted.id).contextId = 'delete-me';
  await sessions.delete('test', deleted.id);
  const quit = await create('desktop quit');
  await sessions.stopAndArchive('test', 'quit');
  const crashed = await create('interrupted before native context');
  pty.terminals.at(-1).data('saved replay');
  await sessions.get('test', crashed.id).outputWrite;
  const loaded = await restart();
  const windowId = randomUUID();
  const [first, concurrent] = await Promise.all([recoverSessions(loaded, 'test', windowId), recoverSessions(loaded, 'test', randomUUID())]);
  assert.deepEqual(concurrent.sessions, []);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(new Set(first.sessions.map(session => session.restoredFrom)), new Set([quit.id, crashed.id]));
  assert.ok(first.sessions.every(session => session.windowId === windowId));
  const recovered = first.sessions.find(session => session.restoredFrom === crashed.id);
  assert.equal(recovered.contextId, undefined);
  assert.equal(loaded.attach('test', recovered.id).data, 'saved replay');
  assert.equal((await recoverSessions(loaded, 'test', windowId)).sessions.length, 0);
  assert.equal(loaded.list('test').sessions.length, 2, 'reopening must not launch duplicate processes');
  await loaded.archive('test', recovered.id);
  assert.equal((await recoverSessions(loaded, 'test', windowId)).sessions.length, 0, 'a later manual archive stays closed');
  await loaded.stopAndArchive('test', 'quit');
  const again = await restart();
  assert.deepEqual((await recoverSessions(again, 'test', randomUUID())).sessions.map(session => session.restoredFrom), [quit.id]);
  await again.stopAndArchive('test', 'close');
});

for (const shutdown of ['completed', 'interrupted']) {
  test(`opening an upgraded plugin restores sessions after ${shutdown} shutdown without duplicate processes`, async t => {
    const { storage, sessions, pty, restart } = await setup(t);
    const original = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, name: 'upgrade recovery' });
    sessions.get('test', original.id).contextId = 'native-context';
    pty.terminals[0].data('output before upgrade');
    await sessions.get('test', original.id).outputWrite;
    if (shutdown === 'interrupted') {
      sessions.processControl = async () => { throw Error('forced upgrade shutdown'); };
      await assert.rejects(sessions.stopAndArchive('test', 'upgrade'), /forced upgrade shutdown/);
    } else {
      await sessions.stopAndArchive('test', 'upgrade');
    }
    const loaded = await restart();
    const windowId = randomUUID();
    const [recovered, concurrent] = await Promise.all([
      recoverSessions(loaded, 'test', windowId), recoverSessions(loaded, 'test', randomUUID())
    ]);
    assert.deepEqual(recovered.errors, []);
    assert.equal(recovered.sessions.length, 1);
    const [restored] = recovered.sessions;
    assert.equal(restored.restoredFrom, original.id);
    assert.equal(restored.windowId, windowId);
    assert.equal(restored.contextId, 'native-context');
    assert.equal(loaded.attach('test', restored.id).data, 'output before upgrade');
    assert.deepEqual(concurrent.sessions, []);
    assert.deepEqual((await recoverSessions(loaded, 'test', randomUUID())).sessions, []);
    assert.equal(loaded.list('test').sessions.length, 1);
    await loaded.stopAndArchive('test', 'close');
  });
}

test('upgrade recovery leaves explicitly closed or native-deleted histories closed', async t => {
  const { storage, sessions, restart } = await setup(t);
  for (const reason of ['closed', 'disable', 'remove', 'exited', 'retried']) {
    const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, name: reason });
    await sessions.archive('test', created.id, reason);
  }
  const deleted = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, name: 'deleted context' });
  sessions.get('test', deleted.id).nativeDeleted = true;
  await sessions.archive('test', deleted.id, 'upgrade');
  const loaded = await restart();
  assert.deepEqual((await recoverSessions(loaded, 'test', randomUUID())).sessions, []);
  assert.equal(loaded.list('test').archives.length, 6);
});

for (const action of ['archive', 'delete']) {
  test(`a crash during manual ${action} preserves the close intent and never auto restores it`, async t => {
    const { storage, sessions, restart } = await setup(t);
    const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root });
    sessions.get('test', created.id).contextId = 'native-context';
    let entered;
    const stopped = new Promise(resolve => { entered = resolve; });
    let release;
    sessions.processControl = () => new Promise(resolve => { release = resolve; entered(); });
    const closing = sessions[action]('test', created.id);
    await stopped;
    const loaded = await restart();
    assert.notEqual((await loaded.readArchive('test', created.id)).reason, 'interrupted');
    assert.deepEqual((await recoverSessions(loaded, 'test', randomUUID())).sessions, []);
    release();
    await closing;
  });
}

for (const archived of [false, true]) {
  test(`failed manual deletion of an ${archived ? 'archived' : 'active'} session stays closed after desktop quit`, async t => {
    const { storage, sessions, restart } = await setup(t);
    const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root });
    sessions.get('test', created.id).contextId = 'native-context';
    if (archived) {
      await sessions.archive('test', created.id, 'quit');
    }
    sessions.deleteContext = async () => { throw Error('native deletion unavailable'); };
    await assert.rejects(sessions.delete('test', created.id), /native deletion unavailable/);
    await sessions.stopAndArchive('test', 'quit');
    assert.equal(sessions.list('test').archives[0].reason, 'deleted');
    const loaded = await restart();
    assert.equal((await loaded.readArchive('test', created.id)).reason, 'deleted');
    assert.deepEqual((await recoverSessions(loaded, 'test', randomUUID())).sessions, []);
  });
}

test('reopening a normally closed plugin restores its windows after an earlier failed desktop quit', async t => {
  const { storage, sessions, restart } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root });
  const stop = sessions.processControl;
  sessions.processControl = async () => { throw Error('temporary stop failure'); };
  await assert.rejects(sessions.stopAndArchive('test', 'quit'), /temporary stop failure/);
  sessions.processControl = stop;
  await sessions.stopAndArchive('test', 'close');
  assert.equal((await sessions.readArchive('test', created.id)).reason, 'close');
  const loaded = await restart();
  assert.deepEqual((await recoverSessions(loaded, 'test', randomUUID())).sessions.map(session => session.restoredFrom), [created.id]);
  await loaded.stopAndArchive('test', 'close');
});

test('a reopened view reclaims orphaned terminals without duplicating processes or taking another live window', async t => {
  const { storage, sessions, pty } = await setup(t);
  const crashedWindow = randomUUID();
  const liveWindow = randomUUID();
  const create = windowId => sessions.create('test', { adapterId: 'codex', cwd: storage.root, windowId });
  const orphaned = await create(crashedWindow);
  const sibling = await create(liveWindow);
  await recoverSessions(sessions, 'test', crashedWindow, [crashedWindow, liveWindow]);
  const reopened = randomUUID();
  const result = await recoverSessions(sessions, 'test', reopened, [reopened, liveWindow]);
  assert.deepEqual(result.sessions.map(session => session.id), [orphaned.id]);
  assert.equal(sessions.get('test', orphaned.id).windowId, reopened);
  assert.equal(sessions.get('test', sibling.id).windowId, liveWindow);
  assert.equal(pty.terminals.length, 2, 'a surviving terminal must be reattached instead of restarted');
  await sessions.stopAndArchive('test', 'close');
});

test('one failed automatic restore leaves history recoverable and does not block the other windows', async t => {
  const { storage, sessions, restart } = await setup(t);
  const failed = await sessions.create('test', { adapterId: 'codex', name: 'missing engine', cwd: storage.root });
  const good = await sessions.create('test', { adapterId: 'codex', name: 'available', cwd: storage.root });
  await sessions.stopAndArchive('test', 'quit');
  const loaded = await restart();
  const adapter = loaded.adapter;
  loaded.adapter = (...args) => ({ ...adapter(...args), buildLaunch: input => {
    if (input.name === failed.name) {
      throw Error('engine unavailable');
    }
    return adapter(...args).buildLaunch(input);
  } });
  const progress = [];
  const result = await recoverSessions(loaded, 'test', randomUUID(), undefined, state => {
    progress.push({ completed: state.completed, total: state.total, failed: state.errors.length });
    if (state.completed === 1) { throw Error('progress view unavailable'); }
  });
  assert.deepEqual(progress.map(state => state.completed), [0, 0, 1, 1, 1]);
  assert.ok(progress.every(state => state.total === 2));
  assert.equal(progress.at(-1).failed, 1);
  assert.deepEqual(result.sessions.map(session => session.restoredFrom), [good.id]);
  assert.equal(result.errors[0].sessionId, failed.id);
  assert.equal((await loaded.readArchive('test', failed.id)).reason, 'quit');
  await loaded.stopAndArchive('test', 'close');
  const retry = await restart();
  assert.deepEqual(new Set((await recoverSessions(retry, 'test', randomUUID())).sessions.map(session => session.restoredFrom)),
    new Set([failed.id, good.id]));
  await retry.stopAndArchive('test', 'close');
});

for (const reason of ['close', 'quit', 'upgrade']) {
  test(`repeated ${reason} and reopen retain window history without reviving manually archived sessions`, async t => {
    const { storage, sessions, restart } = await setup(t);
    const original = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, name: 'keep window' });
    const manual = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, name: 'leave archived' });
    await sessions.archive('test', manual.id);
    await sessions.stopAndArchive('test', reason);
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = await restart();
      const windowId = randomUUID();
      const recovered = await recoverSessions(loaded, 'test', windowId);
      assert.deepEqual(recovered.sessions.map(session => session.restoredFrom), [original.id]);
      assert.notEqual(recovered.sessions[0].id, original.id);
      assert.equal(recovered.sessions[0].windowId, windowId);
      await recoverSessions(loaded, 'test', randomUUID());
      assert.equal(loaded.list('test').sessions.length, 1);
      await loaded.stopAndArchive('test', reason);
    }
  });
}

test('archived restored generations keep stable history identities across repeated startup', async t => {
  const { storage, restart } = await setup(t);
  const originalId = randomUUID();
  const generationId = randomUUID();
  await storage.writeJson(`plugin-data/test/sessions/${generationId}.json`, {
    id: generationId, pluginId: 'test', adapterId: 'codex', name: 'saved generation', cwd: storage.root,
    lifecycle: 'archived', reason: 'quit', restoredFrom: originalId, logId: generationId,
    createdAt: new Date().toISOString(), contextId: 'native-context'
  });
  const loaded = await restart();
  assert.equal(loaded.list('test').archives[0].id, originalId);
  assert.equal((await loaded.readArchive('test', originalId)).contextId, 'native-context');
  const again = await restart();
  assert.equal(again.list('test').archives.length, 1);
  assert.equal(again.list('test').archives[0].id, originalId);
});


test('automatic recovery waits through host creation contention and restores one session at a time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const order = [];
  const sessions = {
    recover: async () => ({ windowId: 'window', sessions: [], archives: [{ id: 'one' }, { id: 'two' }] }),
    restore: async (_plugin, id) => {
      order.push(id);
      if (id === 'one' && attempts++ < 35) {
        throw Object.assign(Error('插件正在创建任务'), { code: 'PLUGIN_BUSY' });
      }
      return { id };
    }
  };
  const pending = recoverSessions(sessions, 'test', 'window');
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  const result = await pending;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sessions.map(session => session.id), ['one', 'two']);
  assert.deepEqual(order, [...Array(36).fill('one'), 'two']);
});


test('restoration retries legacy host contention but never retries engine failures', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const sessions = { restore: async () => {
    if (++calls === 1) {
      throw Object.assign(Error('插件正在创建任务'), { code: 'HOST_ERROR' });
    }
    return { id: 'restored' };
  } };
  const pending = restoreWhenReady(sessions, 'test', 'one', 'window');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(500);
  assert.deepEqual(await pending, { id: 'restored' });
  calls = 0;
  sessions.restore = async () => { calls++; throw Error('engine unavailable'); };
  await assert.rejects(restoreWhenReady(sessions, 'test', 'one', 'window'), /engine unavailable/);
  assert.equal(calls, 1);
});

test('a permanently held creation lock has a bounded wait and preserves the failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const sessions = { restore: async () => { calls++; throw Error('插件正在创建任务'); } };
  const pending = assert.rejects(restoreWhenReady(sessions, 'test', 'one', 'window'), /插件正在创建任务/);
  for (let i = 0; i < 241; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(500);
  }
  await pending;
  assert.equal(calls, 241);
});

test('managed restoration waits for live engine readiness before launching the next window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let ready = false;
  const sessions = {
    recover: async () => ({ windowId: 'window', sessions: [], archives: [{ id: 'one', name: '前端' }, { id: 'two', name: '后端' }] }),
    restore: async (_, id) => {
      calls.push(id);
      return { id, protocol: 'managed-terminal', activity: id === 'one' ? 'unknown' : 'idle' };
    },
    list: async () => ({ sessions: [{ id: 'one', protocol: 'managed-terminal', activity: ready ? 'idle' : 'unknown' }] })
  };
  const progress = [];
  const pending = recoverSessions(sessions, 'test', 'window', [], state => progress.push({ ...state }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['one']);
  assert.equal(progress.at(-1).completed, 0);
  assert.equal(progress.at(-1).current.name, '前端');
  ready = true;
  t.mock.timers.tick(100);
  await pending;
  assert.deepEqual(calls, ['one', 'two']);
  assert.equal(progress.at(-1).completed, 2);
});

test('managed startup failure cannot count as a completed restoration', async () => {
  const sessions = {
    recover: async () => ({ windowId: 'window', sessions: [], archives: [{ id: 'one', name: '失败' }] }),
    restore: async () => ({ id: 'one', protocol: 'managed-terminal', activity: 'unknown', exited: true, error: { message: 'startup failed' } })
  };
  const progress = [];
  const result = await recoverSessions(sessions, 'test', 'window', [], state => progress.push(state.completed));
  assert.equal(result.errors.length, 1);
  assert.equal(progress.at(-1), 0);
});

test('a stalled readiness read times out without blocking the remaining windows', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const sessions = {
    recover: async () => ({ windowId: 'window', sessions: [], archives: [{ id: 'one' }, { id: 'two' }] }),
    restore: async (_, id) => {
      calls.push(id);
      return { id, protocol: 'managed-terminal', activity: id === 'one' ? 'unknown' : 'idle' };
    },
    list: () => new Promise(() => {})
  };
  const pending = recoverSessions(sessions, 'test', 'window');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(119900);
  const result = await pending;
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(result.sessions.map(session => session.id), ['two']);
  assert.match(result.errors[0].message, /就绪超时/);
});

test('readiness deadline includes time spent in successful status reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const current = { id: 'one', protocol: 'managed-terminal', activity: 'unknown' };
  const sessions = {
    restore: async () => current,
    list: async () => {
      t.mock.timers.tick(119900);
      return { sessions: [current] };
    }
  };
  const pending = assert.rejects(restoreWhenReady(sessions, 'test', 'one', 'window'), /就绪超时/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(100);
  await pending;
});

test('recovery reads only the replay tail while preserving the complete disk history across restores', async t => {
  const { storage, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, name: 'large history' });
  const original = sessions.get('test', created.id);
  await sessions.archive('test', created.id);
  const history = 'first output\n' + '历史记录\n'.repeat(500000) + 'last output\n';
  await writeFile(original.outputPath, history);
  const record = await sessions.readArchive('test', created.id, { recovery: true });
  assert.ok(Buffer.byteLength(record.output) <= 2 * 1024 * 1024);
  assert.equal(record.truncated, true);
  assert.ok(!record.output.includes('first output'));
  assert.ok(!record.output.includes('\ufffd'));
  const restored = await sessions.restore('test', created.id);
  assert.equal(await readFile(sessions.get('test', restored.id).outputPath, 'utf8'), history);
  assert.match(sessions.get('test', restored.id).output, /last output/);
  assert.equal(restored.truncated, true);
  assert.equal((await sessions.readArchive('test', created.id)).output, history);
  const archived = await sessions.archive('test', restored.id);
  const again = await sessions.restore('test', archived.id);
  assert.equal(await readFile(sessions.get('test', again.id).outputPath, 'utf8'), history);
});
