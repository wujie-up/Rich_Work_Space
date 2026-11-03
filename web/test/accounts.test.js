import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';

test('local accounts authenticate without storing passwords or bearer sessions, revoking on edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deckpg-web-auth-'));
  const accounts = new Accounts(directory);
  try {
    await assert.rejects(accounts.save('short', '1234567'), /密码/);
    await accounts.save('eight', '12345678');
    assert.ok(await accounts.login('eight', '12345678'));
    await accounts.remove('eight');
    await accounts.save('alice', 'example-password');
    assert.equal(await accounts.login('alice', 'wrong'), null);
    const session = await accounts.login('alice', 'example-password');
    assert.equal(accounts.session(session.token).username, 'alice');
    assert.equal(accounts.session('unknown'), null);
    const bytes = await readFile(join(directory, 'accounts.sqlite'));
    assert.equal(bytes.includes(Buffer.from('example-password')), false);
    assert.equal(bytes.includes(Buffer.from(session.token)), false);
    await accounts.save('alice', 'replacement-password');
    assert.equal(accounts.session(session.token), null);
    const second = await accounts.login('alice', 'replacement-password');
    accounts.revokeAll();
    assert.equal(accounts.session(second.token), null);
    await accounts.remove('alice');
    assert.deepEqual(accounts.list(), []);
  } finally {
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
