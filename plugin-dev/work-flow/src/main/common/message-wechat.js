import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { receiverEvents } from './message-receiver.js';

export async function createWechatSdk({ connection, dataDirectory }) {
  // Disable the SDK's payload/auth logging before loading its modules.
  process.env.WECHATY_LOG = 'silent';
  const [{ WechatyBuilder, log }, { PuppetService }, { default: qr }, { types }] = await Promise.all([
    import('wechaty'), import('wechaty-puppet-service'), import('qrcode'), import('wechaty-puppet')
  ]);
  log.level('silent');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const puppet = new PuppetService({ token: connection.token, tls: { disable: false }, ...(connection.endpoint ? { endpoint: connection.endpoint } : {}) });
  const bot = WechatyBuilder.build({ name: join(dataDirectory, 'session'), puppet });
  return { bot, textType: types.Message.Text, qr: value => qr.toDataURL(value) };
}

export function createWechatReceiver(options) {
  const events = receiverEvents(options);
  let bot;
  let stopped = false;
  const handlers = new Map();
  const on = (name, handler) => {
    const guarded = name === 'message' ? events.message(handler) : events.guard(handler);
    handlers.set(name, guarded);
    bot.on(name, guarded);
  };
  return {
    async start() {
      events.status({ state: 'connecting' });
      const sdk = await (options.sdkFactory || createWechatSdk)(options);
      bot = sdk.bot;
      if (stopped) {
        await bot.stop();
        return;
      }
      on('error', events.error);
      on('scan', async (code, status) => {
        if ([2, 3].includes(status)) {
          events.status({ state: 'scan', qrDataUrl: await sdk.qr(code) });
        }
      });
      on('login', user => events.status({ state: 'connected', account: user.name() }));
      on('logout', () => events.status({ state: 'disconnected' }));
      on('message', async message => {
        if (message.self() || message.type() !== sdk.textType) {
          events.ignore('self-or-non-text');
          return;
        }
        const sender = message.talker();
        const room = message.room();
        await events.deliver({ channel: 'wechat', connectionId: options.connection.id, messageId: message.id,
          chat: { id: room?.id || sender.id, type: room ? 'group' : 'private', name: room ? room.payload?.topic || '' : sender.name() },
          sender: { id: sender.id, name: sender.name() }, text: message.text(), sentAt: message.date().getTime() });
      });
      try {
        await bot.start();
      } finally {
        // Wechaty can finish initialization after stop() saw an inactive bot.
        if (stopped) {
          await bot.stop();
        }
      }
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      const drained = events.stop();
      if (bot) {
        for (const [name, handler] of handlers) {
          bot.removeListener(name, handler);
        }
        // Keep an error sink while SDK shutdown drains its own callbacks.
        bot.on('error', () => {});
        await bot.stop();
      }
      await drained;
    }
  };
}
