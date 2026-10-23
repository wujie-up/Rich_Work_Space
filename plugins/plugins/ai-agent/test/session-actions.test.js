import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore, fakePty } from '../../../../desk/test/helpers.js';
import { Sessions } from '../src/main/common/sessions.js';

test('restore coalesces; fork needs idle context; unsupported restore never launches', async (t) => {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const adapter = { capabilities: { restore: true, fork: true }, buildLaunch: () => ({ command: '/bin/cat', args: [] }),
    resolveContext: async () => 'context-test' };
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(), adapter: () => adapter,
    processControl: async (s) => s.terminal.kill() });
  const a = await sessions.create('test', { adapterId: 'test', cwd: '/tmp' });
  await assert.rejects(sessions.fork('test', a.id, 'fork'), { code: 'SESSION_BUSY' });
  sessions.get('test', a.id).activity = 'idle';
  const fork = await sessions.fork('test', a.id, 'fork');
  assert.equal(fork.contextId, 'context-test');
  await sessions.archive('test', a.id);
  const [one, two] = await Promise.all([sessions.restore('test', a.id), sessions.restore('test', a.id)]);
  assert.equal(one.id, two.id);
  assert.equal(pty.terminals.length, 3);
  adapter.resolveContext = async () => undefined;
  sessions.get('test', one.id).activity = 'idle';
  await assert.rejects(sessions.fork('test', one.id, 'unknown'), { code: 'CONTEXT_UNKNOWN' });
  assert.equal((await sessions.archive('test', one.id)).contextId, undefined, 'ambiguous resolution clears an inherited context');
  await sessions.stopAndArchive('test', 'test');
  adapter.capabilities.restore = false;
  await assert.rejects(sessions.restore('test', a.id), { code: 'UNSUPPORTED_CAPABILITY' });
});
