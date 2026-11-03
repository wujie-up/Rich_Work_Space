import test from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(),
    adapter: () => ({ buildLaunch: () => ({ command: 'fixture', args: [], env: {} }) }) });
  const record = await sessions.create('test', { adapterId: 'fixture', cwd: storage.root });
  return { sessions, session: sessions.get('test', record.id) };
}

test('small terminal redraws allocate for incoming bytes instead of copying the entire replay', async t => {
  const { sessions, session } = await setup(t);
  sessions.bufferOutput(session, 'x'.repeat(2 * 1024 * 1024));
  const from = Buffer.from;
  let encodedBytes = 0;
  Buffer.from = function (value, ...args) {
    if (typeof value === 'string') {
      encodedBytes += Buffer.byteLength(value);
    }
    return from(value, ...args);
  };
  try {
    for (let index = 0; index < 128; index++) {
      sessions.bufferOutput(session, 'y'.repeat(512));
    }
  } finally {
    Buffer.from = from;
  }
  assert.ok(encodedBytes < 8 * 1024 * 1024, `64 KiB of redraws encoded ${encodedBytes} bytes`);
  assert.equal(sessions.attach('test', session.id).data, 'x'.repeat(2031616) + 'y'.repeat(65536));
});

test('replay wrap and oversized chunks retain the UTF-8 tail without corrupting characters', async t => {
  const { sessions, session } = await setup(t);
  sessions.bufferOutput(session, 'x'.repeat(2097150));
  sessions.bufferOutput(session, '😀中');
  assert.equal(sessions.attach('test', session.id).data, 'x'.repeat(2097145) + '😀中');
  sessions.bufferOutput(session, '中'.repeat(800000) + 'END');
  const snapshot = sessions.attach('test', session.id);
  assert.equal(snapshot.data, '中'.repeat(699049) + 'END');
  assert.equal(session.truncated, true);
  sessions.bufferOutput(session, '尾');
  assert.equal(sessions.attach('test', session.id).data, '中'.repeat(699048) + 'END尾');
  assert.ok(!snapshot.data.includes('\ufffd'));
});
