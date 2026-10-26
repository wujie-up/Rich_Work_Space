import { receiverEvents } from './message-receiver.js';

async function sdkFactory(handler, options, events) {
  const { WSClient, EventDispatcher, Client } = await import('@larksuiteoapi/node-sdk');
  // Never forward SDK arguments: they can contain credentials, QR material and raw event bodies.
  const logger = { trace() {}, debug() {}, info() {}, warn: events.error, error: events.error };
  const config = { appId: options.connection.appId, appSecret: options.connection.appSecret, logger };
  const identity = await new Client(config).request({ url: '/open-apis/bot/v3/info', method: 'GET' });
  if (!identity.bot?.open_id) {
    throw Error('BOT_IDENTITY_UNAVAILABLE');
  }
  return {
    botId: identity.bot.open_id,
    client: new WSClient({ ...config, onReady: () => events.status({ state: 'connected' }),
      onError: events.error, onReconnecting: () => events.status({ state: 'connecting' }) }),
    eventDispatcher: new EventDispatcher({ logger }).register({ 'im.message.receive_v1': handler })
  };
}

export function createFeishuReceiver(options) {
  const events = receiverEvents(options);
  let client;
  let botId;
  let stopped = false;
  const handler = events.message(async data => {
    const { message, sender } = data;
    if (sender?.sender_type !== 'user' || message?.chat_type !== 'group' || message.message_type !== 'text') {
      events.ignore('self-or-non-group-or-non-text');
      return;
    }
    const content = JSON.parse(message.content);
    await events.deliver({ channel: 'feishu', connectionId: options.connection.id, messageId: message.message_id,
      chat: { id: message.chat_id, type: 'group', name: '' }, sender: { id: sender.sender_id?.open_id, name: '' },
      text: content.text, sentAt: Number(message.create_time), mentioned: Boolean(botId && message.mentions?.some(mention => mention.id?.open_id === botId)) });
  });
  return {
    async start() {
      events.status({ state: 'connecting' });
      const sdk = await (options.sdkFactory || sdkFactory)(handler, options, events);
      client = sdk.client;
      botId = sdk.botId;
      if (stopped) {
        await client.close({ force: true });
        return;
      }
      await client.start({ eventDispatcher: sdk.eventDispatcher });
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      const drained = events.stop();
      await client?.close({ force: true });
      await drained;
    }
  };
}
