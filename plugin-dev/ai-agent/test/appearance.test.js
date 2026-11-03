import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAppearance } from '../src/main/common/appearance.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

function register(storage, events = []) {
  const methods = new Map();
  registerAppearance({ pluginId: 'ai-agent-sessions', storage, methods: { register: (name, handler) => methods.set(name, handler) },
    emit: (channel, value) => events.push({ channel, value }) });
  return methods;
}

test('字号默认 14px，按插件持久化，重新注册后保留并广播到各视图', async t => {
  const storage = await temporaryStore(t);
  const events = [];
  const methods = register(storage, events);
  assert.deepEqual(await methods.get('appearance.get')(), { fontSize: 14 });
  for (const fontSize of [10, 18, 24]) {
    assert.deepEqual(await methods.get('appearance.save')({ fontSize }), { fontSize });
    assert.deepEqual(await register(storage).get('appearance.get')(), { fontSize });
  }
  assert.deepEqual(await storage.readJson('plugin-data/ai-agent-sessions/appearance.json'), { fontSize: 24 });
  assert.deepEqual(events.at(-1), { channel: 'appearance.changed', value: { fontSize: 24 } });
});

test('拒绝越界及非整数字号，写入失败不广播、不覆盖原设置', async t => {
  const storage = await temporaryStore(t);
  const events = [];
  const methods = register(storage, events);
  await methods.get('appearance.save')({ fontSize: 16 });
  for (const fontSize of [9, 25, 14.5, '18', null]) {
    await assert.rejects(methods.get('appearance.save')({ fontSize }), { code: 'INVALID_ARGUMENT' });
  }
  const failing = register({ readJson: storage.readJson.bind(storage), writeJson: async () => { throw Error('disk full'); } }, events);
  await assert.rejects(failing.get('appearance.save')({ fontSize: 20 }), /disk full/);
  assert.deepEqual(await methods.get('appearance.get')(), { fontSize: 16 });
  assert.equal(events.length, 1);
});

test('读取异常或损坏配置时，使用默认字号', async () => {
  for (const readJson of [async () => { throw Error('unreadable'); }, async () => ({ fontSize: 100 })]) {
    assert.deepEqual(await register({ readJson }).get('appearance.get')(), { fontSize: 14 });
  }
});
