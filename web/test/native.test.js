import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../desk/src/main/common/storage.js';
import { nativeWeb } from '../src/server/native.js';

test('disabled native integration restores without creating accounts, certificates or upload directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckpg-web-disabled-'));
  const bridge = nativeWeb({ storage: new Storage(root), root });
  try {
    await bridge.restore();
    bridge.emit('plugins.changed', {});
    await bridge.close();
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
