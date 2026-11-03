async function sdkFactory(handler, { channel, status }) {
  const { Client, WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');
  const error = () => status({ state: 'error', error: '飞书连接异常，请检查应用权限和网络' });
  // SDK arguments may include secrets or raw messages; only a fixed operational status crosses the boundary.
  const logger = { trace() {}, debug() {}, info() {}, warn: error, error };
  const config = { appId: channel.appId, appSecret: channel.appSecret, logger };
  const api = new Client(config);
  const identity = await api.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
  if (!identity.bot?.open_id) { throw Error('无法读取飞书机器人身份'); }
  const ws = new WSClient({ ...config, onReady: () => status({ state: 'connected' }), onError: error,
    onReconnecting: () => status({ state: 'connecting' }) });
  const dispatcher = new EventDispatcher({ logger }).register({ 'im.message.receive_v1': handler });
  return { botId: identity.bot.open_id, start: () => ws.start({ eventDispatcher: dispatcher }), stop: () => ws.close({ force: true }),
    send: input => api.im.v1.message.reply(input) };
}

export class FeishuChannel {
  constructor(options) { Object.assign(this, options); this.pending = new Set(); }

  async ingest(data) {
    if (this.stopped) { return; }
    const { message, sender } = data;
    if (sender?.sender_type !== 'user' || !['p2p', 'group'].includes(message?.chat_type) || message.message_type !== 'text') { return; }
    const content = JSON.parse(message.content);
    const mentions = message.mentions?.filter(item => item.id?.open_id === this.sdk.botId) || [];
    const text = mentions.reduce((value, item) => value.replaceAll(item.key, ''), content.text).trim();
    await this.receive({ messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type === 'group' ? 'group' : 'private',
      senderId: sender.sender_id?.open_id, text, sentAt: Number(message.create_time), mentioned: mentions.length > 0,
      replyContext: { messageId: message.message_id } });
  }

  async start() {
    this.status({ state: 'connecting' });
    this.sdk = await (this.sdkFactory || sdkFactory)(data => {
      const work = this.ingest(data);
      this.pending.add(work);
      work.finally(() => this.pending.delete(work)).catch(() => {});
      // Returning the ingestion promise keeps native acknowledgement after durable acceptance.
      return work;
    }, this);
    if (this.stopped) { await this.sdk.stop(); return; }
    await this.sdk.start();
    if (this.stopped) { await this.sdk.stop(); }
  }

  async send({ source, text, clientId }) {
    if (this.stopped || !this.sdk) { throw Error('飞书渠道已停止'); }
    const result = await this.sdk.send({ path: { message_id: source.replyContext.messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }), uuid: clientId, reply_in_thread: false } });
    if (result.code !== 0 || !result.data?.message_id) { throw Error('飞书发送未获确认'); }
    return { messageId: result.data.message_id };
  }

  async stop() {
    this.stopped = true;
    await this.sdk?.stop();
    await Promise.allSettled([...this.pending]);
  }
}
