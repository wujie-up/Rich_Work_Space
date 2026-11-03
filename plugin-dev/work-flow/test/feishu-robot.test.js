import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { FeishuRobotSettings } from '../src/main/common/feishu-robot-settings.js';
import { feishuSign, splitFeishuText, sendFeishuText } from '../src/main/common/feishu-robot.js';

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555';
const key = 'fixture-signing-key';

test('signature matches the Java SDK empty-payload HMAC vector', () => {
  assert.equal(feishuSign(key, 1700000000), 'tGzzuWM2YMs4FJ4yC11q4F0OBCSucEt6n9rn7jFsU+U=');
});

test('robot settings preserve edited secrets and expose only a masked endpoint', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new FeishuRobotSettings({ storage: new Storage(directory), pluginId: 'work-flow' });
  assert.equal((await settings.read()).configured, false);
  await settings.save({ webhook, key });
  const view = await settings.read();
  assert.equal(view.configured, true);
  assert.equal(view.hasKey, true);
  assert.equal(JSON.stringify(view).includes(key), false);
  assert.equal(JSON.stringify(view).includes(webhook), false);
  await settings.save({ webhook: '', key: 'replacement' });
  assert.deepEqual(await settings.snapshot(), { webhook, key: 'replacement' });
  await settings.save({ webhook, key: '' });
  assert.equal((await settings.snapshot()).key, 'replacement');
  await assert.rejects(settings.save({ webhook: 'http://localhost/hook', key }));
  const stored = await readFile(join(directory, 'plugin-data/work-flow/feishu-robot.json'), 'utf8');
  assert.equal(JSON.parse(stored).key, 'replacement');
});

test('text chunks retain all Unicode content and signed payloads validate code=0', async () => {
  const text = '订单通知：中文😀\\\n'.repeat(4000);
  const chunks = splitFeishuText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length > 1);
  const sent = [];
  const result = await sendFeishuText({ webhook, key }, text, { pauseMs: 0, now: () => 1700000000000,
    fetchImpl: async (url, options) => {
      assert.equal(url, webhook);
      assert.equal(options.redirect, 'error');
      assert.ok(Buffer.byteLength(options.body) < 16000);
      const payload = JSON.parse(options.body);
      assert.equal(payload.timestamp, '1700000000');
      assert.equal(payload.sign, feishuSign(key, 1700000000));
      assert.equal(payload.msg_type, 'text');
      sent.push(payload);
      return { ok: true, json: async () => ({ code: 0 }) };
    } });
  assert.equal(result.sentParts, chunks.length);
  assert.equal(sent.length, chunks.length);
});

test('failed responses and ambiguous network errors stop without retry or leaking credentials', async () => {
  let calls = 0;
  await assert.rejects(sendFeishuText({ webhook, key }, 'test', { fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ code: 19021, msg: key + webhook }) };
  } }), error => !error.message.includes(key) && !error.message.includes(webhook) && error.sentParts === 0);
  assert.equal(calls, 1);
  await assert.rejects(sendFeishuText({ webhook, key }, 'test', { fetchImpl: async () => { throw Error(key + webhook); } }),
    error => error.deliveryUnknown === true && !error.stack.includes(key) && !error.stack.includes(webhook));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sendFeishuText({ webhook, key }, 'test', { signal: controller.signal }));
});

test('card delivery validates all signed bodies first and stops after a rejected later card', async () => {
  const { sendFeishuCards } = await import('../src/main/common/feishu-robot.js');
  const config = { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture', key: 'fixture-key' };
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(JSON.parse(options.body).msg_type, 'interactive');
    return { ok: true, json: async () => ({ code: requests === 1 ? 0 : 1 }) };
  };
  await assert.rejects(sendFeishuCards(config, [{ body: 'first' }, { body: 'x'.repeat(21000) }], { fetchImpl, pauseMs: 0 }), /20KB/);
  assert.equal(requests, 0);
  await assert.rejects(sendFeishuCards(config, [{ body: 'first' }, { body: 'second' }, { body: 'third' }], { fetchImpl, pauseMs: 0 }),
    { code: 'FEISHU_SEND_FAILED', sentParts: 1, totalParts: 3, deliveryUnknown: false });
  assert.equal(requests, 2);
});
