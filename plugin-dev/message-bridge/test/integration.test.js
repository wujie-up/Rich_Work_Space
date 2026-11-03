import test from 'node:test';
import assert from 'node:assert/strict';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Conversations } from '../../ai-agent/src/main/common/conversations.js';
import { BridgeSessions } from '../../ai-agent/src/main/common/bridge/sessions.js';
import { registerBridge } from '../../ai-agent/src/main/common/bridge/capabilities.js';
import { MessageBridge } from '../src/main/common/service.js';
import { AgentClient } from '../src/main/common/agent-client.js';
import { WechatChannel } from '../src/main/common/channels/wechat.js';
import { EventEmitter } from 'node:events';
import { nativeGateway, until } from './fixtures/native-gateway.mjs';

class Engine {
  constructor(options) { Object.assign(this, options); this.turns = 0; }
  async start() {}
  async request(method) {
    if (method.startsWith('thread/')) { return { thread: { id: 'native-thread' } }; }
    if (method === 'turn/start') { return { turn: { id: `native-turn-${++this.turns}`, status: 'inProgress' } }; }
    return {};
  }
  close() {}
}

for (const [type, chatType, native] of [['feishu', 'group'], ['wechat', 'private'], ['wechat', 'group'],
  ['wechat', 'private', true], ['wechat', 'group', true]]) {
  test(`real host connects ${type} ${chatType}${native ? ' over local gRPC' : ''} to the exact Agent turn and original chat`, async t => {
    const cleanup = [];
    const storage = await temporaryStore({ after: work => cleanup.push(work) });
    const handlers = new Map();
    const provider = { id: 'ai-agent-sessions', instanceId: 'ai-process', services: [],
      executeCapability: (input, context) => handlers.get(context.capabilityId)(input, context), notifyCapability() {}, cancelCapability() {} };
    const consumer = { id: 'message-bridge', instanceId: 'bridge-process', services: [], notifyCapability() {} };
    const host = new Capabilities({ storage, loaded: new Map([[provider.id, provider], [consumer.id, consumer]]), usable: () => true });
    await host.load();
    const conversations = new Conversations({ pluginId: provider.id, storage, Engine,
      runtime: { launch: async () => ({ engineId: 'codex', runtimeId: 'test', profileId: 'default', args: [], env: { HOME: storage.root } }) },
      createGateway: () => ({ start: async () => {}, close: async () => {}, cancel: async () => {}, refreshCatalog: async () => false }),
      emit() {}, ownProcesses() {} });
    await conversations.load();
    const sessions = new BridgeSessions({ pluginId: provider.id, storage, conversations, sessions: { active: new Map() } });
    await sessions.load();
    await registerBridge({ register: async (descriptor, handler) => {
      handlers.set(descriptor.id, handler); await host.register(provider, descriptor);
    } }, sessions);
    const agent = new AgentClient({ discover: async () => host.discover(),
      authorize: input => host.authorizations.request(consumer, input), authorization: async id => host.authorizations.get(consumer, id),
      invoke: (handle, input, options) => host.invoke(consumer, handle, input, options),
      getInvocation: async id => host.get(consumer, id), revoke: async id => host.authorizations.revoke(consumer, id) });
    const delivered = [];
    const gateway = native ? await nativeGateway({ after: work => cleanup.push(work) }) : undefined;
    const bot = new EventEmitter();
    bot.start = async () => {};
    bot.stop = async () => {};
    const target = async ({ id }) => ({ say: async text => {
      delivered.push({ text, source: { chatId: id, senderId: 'alice' } });
      return { id: 'receipt' };
    } });
    bot.Contact = { find: target };
    bot.Room = { find: target };
    const bridge = new MessageBridge({ pluginId: consumer.id, storage, agent, emit() {},
      channelFactory: async options => type === 'wechat'
        ? new WechatChannel({ ...options, ...(native ? {} : { sdkFactory: async () => ({ bot, textType: 7 }) }) })
        : { start: async () => {}, stop: async () => {}, send: async value => { delivered.push(value); return { messageId: 'receipt' }; } } });
    t.after(async () => {
      await bridge.stop(); await sessions.stop(); await conversations.stop(); await host.flush();
      for (const work of cleanup) { await work(); }
    });
    await bridge.load();
    assert.equal((await agent.authorize()).state, 'pending');
    await host.messages.respond(host.messages.list()[0].id, { text: '允许并记住' });
    assert.equal(await agent.ready(), true);
    assert.ok((await agent.call('catalog')).targets);
    const chatId = chatType === 'group' ? 'group' : 'alice';
    await bridge.saveChannel({ id: 'channel', type, enabled: true, ...gateway?.channel });
    const channel = bridge.config.value.channels[0];
    const prefix = native ? '@小微' : '/agent';
    await bridge.saveRoute({ id: 'rule', enabled: true, channelId: 'channel', chatIds: [chatId], senderIds: ['alice'],
      trigger: { type: 'prefix', value: prefix }, target: { mode: 'dedicated', engineId: 'codex' }, executionPolicy: { mode: 'readOnly' } });
    const source = { channelId: 'channel', messageId: 'inbound', chatId, chatType, senderId: 'alice',
      text: `${prefix} hello`, sentAt: Date.now(), replyContext: { messageId: 'inbound' } };
    if (type === 'wechat') {
      const transport = await bridge.connectChannel(channel);
      const message = { id: source.messageId, self: () => false, type: () => 7, talker: () => ({ id: 'alice' }),
        room: () => chatType === 'group' ? { id: chatId } : null, text: () => source.text, date: () => new Date(source.sentAt),
        mentionSelf: async () => false };
      if (native) {
        await until(() => bridge.snapshot().channels[0].status.state === 'connected');
        gateway.puppet.receive(source);
        gateway.puppet.receive(source);
        await until(() => bridge.snapshot().exchanges.length === 1);
      } else {
        bot.emit('message', message);
        bot.emit('message', message);
      }
      await transport.drain();
    } else {
      await Promise.all([bridge.receive(source), bridge.receive(source)]);
    }
    await bridge.tick();
    await sessions.pump();
    const task = Object.values(sessions.state.tasks)[0];
    const engine = conversations.engines.get(task.targetId).engine;
    engine.onEvent({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: task.turnId, status: 'completed',
      items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Native result' }] } } });
    await bridge.tick();
    assert.equal(engine.turns, 1);
    if (native) {
      assert.deepEqual(gateway.puppet.sent, [{ chatId, text: 'Native result' }]);
      gateway.puppet.receive({ ...source, messageId: 'self-echo', senderId: 'fixture-self' });
      gateway.puppet.receive({ ...source, messageId: 'ordinary', text: 'unmatched message' });
      gateway.puppet.receive({ ...source, messageId: 'follow-up', text: `${prefix} follow up\n甲：收到` });
      await until(() => bridge.snapshot().exchanges.length === 2);
      await bridge.tick();
      await sessions.pump();
      const followUp = Object.values(sessions.state.tasks).find(item => item.turnId !== task.turnId);
      assert.equal(followUp.targetId, task.targetId);
      assert.equal(engine.turns, 2);
      engine.onEvent({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: followUp.turnId, status: 'completed',
        items: [{ id: 'answer-2', type: 'agentMessage', phase: 'final_answer', text: 'Follow-up result' }] } } });
      await bridge.tick();
      assert.deepEqual(gateway.puppet.sent, [{ chatId, text: 'Native result' }, { chatId, text: 'Follow-up result' }]);
      assert.equal(bridge.snapshot().channels[0].status.state, 'connected');
    } else {
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].text, 'Native result');
      assert.deepEqual([delivered[0].source.chatId, delivered[0].source.senderId], [chatId, 'alice']);
    }
    await bridge.revoke();
    assert.equal(await agent.ready(), false);
    assert.equal(bridge.snapshot().exchanges[0].closed, true);
  });
}
