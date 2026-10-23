import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const adapter = { id: 'test', capabilities: {}, buildLaunch: () => ({ command: 'test', args: [], env: {} }) };
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter,
    guard: (_id, work) => work(), processControl: async (s) => s.terminal.kill() });
  return { storage, sessions, pty };
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
  assert.equal(sessions.list('one').sessions[0].exited, true);
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
