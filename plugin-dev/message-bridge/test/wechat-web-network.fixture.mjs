import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WechatChannel } from '../src/main/common/channels/wechat.js';

// Explicit opt-in fixture: contacts the real web login endpoint, without an account, scanning or sending messages.
test('real Wechaty web SDK obtains a scan code and stops cleanly over three starts', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechaty-web-network-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (let cycle = 0; cycle < 3; cycle++) {
    const errors = [];
    let resolveQr;
    let rejectQr;
    const qr = new Promise((resolve, reject) => { resolveQr = resolve; rejectQr = reject; });
    const timeout = setTimeout(() => rejectQr(Error('web scan code timeout')), 15000);
    const channel = new WechatChannel({ pluginId: 'message-bridge', channel: { id: `probe-${cycle}`, puppet: 'wechat4u' },
      storage: { path: async path => join(directory, path) }, receive: async () => assert.fail('unexpected inbound account message'),
      report: (action, error) => errors.push({ action, name: error.name }),
      status: state => {
        if (state.state === 'scan') { resolveQr(state.qrDataUrl); }
        if (state.state === 'error') { rejectQr(Error('web SDK connection failed')); }
      } });
    try {
      await channel.start();
      assert.match(await qr, /^data:image\/png;base64,/);
    } finally {
      clearTimeout(timeout);
      await channel.stop();
    }
    assert.deepEqual(errors, []);
    console.info('[wechat-web-network]', { cycle: cycle + 1, scanCodeReceived: true, stopped: true });
  }
});
