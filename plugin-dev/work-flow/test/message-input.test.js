import test from 'node:test';
import assert from 'node:assert/strict';
import { messageTypes, matchesMessage, validateMessageWorkflow } from '../src/main/common/message-input.js';
import { normalizeTrigger, nextRunAt } from '../src/main/common/triggers.js';
import { Workflows } from '../src/main/common/workflows.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

const message = { channel: 'wechat', connectionId: 'wx', messageId: 'm1', chat: { id: 'g1', type: 'group' },
  sender: { id: 'u1' }, text: '开始部署' };
const entry = { id: 'message', type: 'message.wechat', params: { connectionId: 'wx' } };

test('消息入口只属数据输入，筛选字段 OR/AND、空白不限、类型及关键词', () => {
  assert.deepEqual(messageTypes().map(type => [type.type, type.kind, type.io, type.role]), [
    ['message.wechat', 'input', 'source', 'start'], ['message.feishu', 'input', 'source', 'start']
  ]);
  assert.equal(matchesMessage({ connectionId: 'wx', chatIds: 'g0, g1', senderIds: 'u0\nu1', keyword: '部署' }, message), true);
  for (const params of [{ connectionId: 'other' }, { chatIds: 'g2' }, { senderIds: 'u2' }, { keyword: '^部署' }, { chatType: 'private' }]) {
    assert.equal(matchesMessage({ connectionId: 'wx', ...params }, message), false);
  }
  assert.equal(matchesMessage({ connectionId: 'wx', chatIds: '  ' }, message), true);
  assert.equal(matchesMessage({ connectionId: 'wx' }, { ...message, channel: 'feishu' }), false);
  assert.equal(matchesMessage({ connectionId: 'wx', mentionOnly: false }, { ...message, channel: 'feishu' }), true);
});

test('消息模式默认关闭，不产生定时器；保存拒绝混合、多入口和定时模式', async t => {
  assert.equal(normalizeTrigger({ mode: 'message' }).enabled, false);
  assert.equal(nextRunAt({ mode: 'message', enabled: true }), null);
  const store = new Workflows({ storage: await temporaryStore(t), pluginId: 'work-flow' });
  const saved = await store.save({ nodes: [entry], trigger: { mode: 'message' } });
  assert.equal(saved.trigger.enabled, false);
  for (const input of [
    { nodes: [entry, { id: 'start', type: 'flow.start' }] },
    { nodes: [entry, { ...entry, id: 'm2' }] },
    { nodes: [entry], trigger: { mode: 'interval', every: 1, unit: 'minute' } },
    { nodes: [{ id: 'start', type: 'flow.start' }], trigger: { mode: 'message', enabled: true } },
    { nodes: [{ ...entry, params: {} }], trigger: { mode: 'message', enabled: true } }
  ]) {
    await assert.rejects(store.save(input), { code: 'INVALID_WORKFLOW' });
  }
  assert.doesNotThrow(() => validateMessageWorkflow({ nodes: [entry], trigger: { mode: 'manual' } }));
});
