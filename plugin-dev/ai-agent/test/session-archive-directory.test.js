import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const launches = [];
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(), readGit: async () => null,
    adapter: () => ({ capabilities: { restore: true }, buildLaunch: async input => {
      launches.push(input);
      return { command: 'test', args: [], env: {}, isolated: true };
    } }), processControl: async session => session.terminal.kill() });
  t.after(async () => {
    await sessions.stopAndArchive('test', 'close');
    for (const session of sessions.active.values()) {
      clearTimeout(session.checkpoint);
      await session.outputWrite;
      await session.exitCleanup;
    }
  });
  return { storage, pty, sessions, launches };
}

test('relocated archive resumes native context and replay from its updated directory', async t => {
  const { storage, pty, sessions, launches } = await setup(t);
  const original = join(storage.root, 'original');
  const relocated = join(storage.root, 'relocated');
  await mkdir(original);
  const created = await sessions.create('test', { adapterId: 'codex', cwd: original, name: '前端' });
  sessions.get('test', created.id).contextId = 'native-context';
  pty.terminals[0].data('preserved output');
  await sessions.get('test', created.id).outputWrite;
  await sessions.archive('test', created.id);
  await rename(original, relocated);
  await assert.rejects(sessions.restore('test', created.id), /ENOENT/);
  const before = await storage.readJson(sessions.key({ pluginId: 'test', id: created.id }));
  const updated = await sessions.updateArchiveDirectory('test', created.id, relocated);
  assert.equal(updated.cwd, await realpath(relocated));
  const after = await storage.readJson(sessions.key({ pluginId: 'test', id: created.id }));
  assert.deepEqual(after, { ...before, cwd: await realpath(relocated), git: null, error: null });
  const restored = await sessions.restore('test', created.id);
  assert.equal(restored.cwd, await realpath(relocated));
  assert.equal(restored.contextId, 'native-context');
  assert.equal(launches.at(-1).mode, 'resume');
  assert.equal(sessions.attach('test', restored.id).data, 'preserved output');
  await assert.rejects(sessions.updateArchiveDirectory('test', created.id, storage.root), { code: 'SESSION_BUSY' });
});

test('directory edits enforce ownership, validity and persist before changing cached history', async t => {
  const { storage, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root });
  await sessions.archive('test', created.id);
  await assert.rejects(sessions.updateArchiveDirectory('other', created.id, storage.root), { code: 'SESSION_NOT_FOUND' });
  const file = join(storage.root, 'file');
  await writeFile(file, 'file');
  for (const path of ['', 'relative', join(storage.root, 'missing'), file]) {
    await assert.rejects(sessions.updateArchiveDirectory('test', created.id, path), { code: 'INVALID_ARGUMENT' });
  }
  const before = sessions.archives.get(created.id);
  const write = storage.writeJson;
  storage.writeJson = async () => { throw Error('disk unavailable'); };
  await assert.rejects(sessions.updateArchiveDirectory('test', created.id, storage.root), /disk unavailable/);
  assert.deepEqual(sessions.archives.get(created.id), before);
  storage.writeJson = write;
});
