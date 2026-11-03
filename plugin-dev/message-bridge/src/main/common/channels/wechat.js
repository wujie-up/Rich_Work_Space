import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkNativeGateway, nativeGatewayOptions } from './wechat-native.js';

export function wechatPuppetProvider(channel) {
  // Older channels had no provider field; their stored Service credentials must keep their original meaning.
  const provider = channel.puppet || (channel.token || channel.endpoint ? 'service' : 'wechat4u');
  if (!['wechat4u', 'service', 'native'].includes(provider)) {
    throw Error('不支持的 Wechaty Puppet');
  }
  return provider;
}

export async function createWechatPuppet(channel, options) {
  const provider = wechatPuppetProvider(channel);
  if (provider === 'native') {
    const { NativeWechatPuppet } = await import('./wechat-native-puppet.js');
    return new NativeWechatPuppet(nativeGatewayOptions(channel), options?.signal, options?.cacheDirectory);
  }
  if (provider !== 'wechat4u') {
    const { PuppetService } = await import('wechaty-puppet-service');
    return new PuppetService({ token: channel.token, tls: { disable: false }, ...(channel.endpoint ? { endpoint: channel.endpoint } : {}) });
  }
  const { WechatWebPuppet } = await import('./wechat-web-puppet.js');
  return new WechatWebPuppet(options);
}

async function sdkFactory({ channel, storage, pluginId, report, connectionAbort }) {
  process.env.WECHATY_LOG = 'silent';
  const [{ WechatyBuilder, log }, { default: qr }, { types }] = await Promise.all([
    import('wechaty'), import('qrcode'), import('wechaty-puppet')
  ]);
  log.level('silent');
  const directory = await storage.path(`plugin-data/${pluginId}/wechat/${channel.id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const puppet = await createWechatPuppet(channel, { report, signal: connectionAbort?.signal, cacheDirectory: directory });
  const session = { service: 'session', native: 'session-native', wechat4u: 'session-wechat4u' }[wechatPuppetProvider(channel)];
  return { bot: WechatyBuilder.build({ name: join(directory, session), puppet }), textType: types.Message.Text, qr: value => qr.toDataURL(value) };
}

export class WechatChannel {
  constructor(options) { Object.assign(this, options); this.pending = new Set(); this.handlers = new Map(); }

  updateStatus(status) {
    this.loginVersion = (this.loginVersion || 0) + 1;
    console.info('[message-bridge:wechat-status]', { pluginId: this.pluginId, channelId: this.channel.id, state: status.state });
    this.status(status);
  }

  on(name, callback) {
    const handler = (...args) => {
      if (this.stopped) { return; }
      const work = Promise.resolve().then(() => callback(...args));
      this.pending.add(work);
      work.catch(error => {
        this.report?.('wechat-event', error);
        this.updateStatus({ state: 'error', error: '微信处理失败，请检查连接和插件日志' });
      })
        .finally(() => this.pending.delete(work));
    };
    this.handlers.set(name, handler);
    this.bot.on(name, handler);
  }

  async start() {
    const provider = wechatPuppetProvider(this.channel);
    if (provider !== 'wechat4u' && !this.channel.token?.trim()) {
      this.updateStatus({ state: 'login_required', error: provider === 'native' ? '请配置本机网关 Token；它与激活码不同' : '请配置 Puppet Service Token' });
      return;
    }
    console.info('[message-bridge:wechat-connect]', { pluginId: this.pluginId, channelId: this.channel.id, provider });
    this.updateStatus({ state: 'connecting' });
    try {
      if (provider === 'native') {
        this.connectionAbort = new AbortController();
        await checkNativeGateway(this.channel, this.connectionAbort.signal);
        if (this.stopped) { return; }
      }
      await this.startBot(provider);
    } catch (error) {
      if (provider !== 'native') { throw error; }
      if (this.stopped) { return; }
      this.report?.('wechat-native-connect', error);
      await this.stop();
      this.updateStatus({ state: 'error', error: '本机微信网关未连接，请启动原生网关并检查端点、网关 Token 及客户端登录状态' });
    }
  }

  async startBot(provider) {
    const sdk = await (this.sdkFactory || sdkFactory)(this);
    this.bot = sdk.bot;
    if (this.stopped) { await this.bot.stop(); return; }
    this.on('error', error => {
      this.report?.('wechat-sdk', error);
      const detail = error.message?.match(/微信网页登录(?:被拒绝|凭据不完整)[\s\S]*/)?.[0];
      this.updateStatus({ state: 'error', error: provider === 'native'
        ? '本机微信网关异常，请检查网关 Token、客户端登录及原生桥接就绪状态' : detail || (provider === 'service'
        ? '微信服务连接异常，请检查服务凭据' : '微信网页连接失败，请重新扫码；仍失败时查看插件日志') });
    });
    this.on('scan', async (code, status) => {
      if (status === 2) {
        const version = this.loginVersion = (this.loginVersion || 0) + 1;
        const qrDataUrl = await sdk.qr(code);
        // QR rendering is asynchronous; a newer login/error event must win.
        if (!this.stopped && version === this.loginVersion) { this.updateStatus({ state: 'scan', qrDataUrl }); }
        return;
      }
      const state = { 3: 'scanned', 4: 'confirming', 5: 'login_required', 0: 'login_required' }[status];
      if (state) { this.updateStatus({ state }); }
    });
    this.on('login', user => this.updateStatus({ state: 'connected', account: user.name() }));
    this.on('logout', () => this.updateStatus({ state: 'login_required' }));
    this.on('message', async message => {
      if (message.self() || message.type() !== sdk.textType) { return; }
      const sender = message.talker();
      const room = message.room();
      await this.receive({ messageId: message.id, chatId: room?.id || sender.id, chatType: room ? 'group' : 'private', senderId: sender.id,
        text: message.text(), sentAt: message.date().getTime(), mentioned: room ? await message.mentionSelf() : false, replyContext: {} });
    });
    try { await this.bot.start(); }
    finally { if (this.stopped) { await this.bot.stop(); } }
  }

  async send({ source, text }) {
    if (this.stopped || !this.bot) { throw Error('微信渠道未登录'); }
    const target = source.chatType === 'group' ? await this.bot.Room.find({ id: source.chatId }) : await this.bot.Contact.find({ id: source.chatId });
    if (!target) { throw Error('微信原会话暂不可用'); }
    const result = await target.say(text);
    return { messageId: result?.id };
  }

  async drain() { await Promise.allSettled([...this.pending]); }

  async stop() {
    this.stopped = true;
    this.connectionAbort?.abort();
    if (this.bot) {
      for (const [name, handler] of this.handlers) { this.bot.removeListener(name, handler); }
      this.bot.on('error', error => this.report?.('wechat-stopping', error));
      await this.bot.stop();
    }
    await this.drain();
  }
}
