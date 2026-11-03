import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const apiRoot = 'https://ilinkai.weixin.qq.com';
const baseInfo = { channel_version: '0.1.0', bot_agent: 'WorkDesk/0.1.0' };
const appHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '256' };

function trustedBase(value = apiRoot) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port) {
    throw Error('微信 API 地址必须是可信的官方 HTTPS 域名');
  }
  return url.origin;
}

export class WeixinBotChannel {
  constructor(options) {
    Object.assign(this, options);
    this.fetch ||= globalThis.fetch;
    this.controller = new AbortController();
  }

  async request(path, body, { base = this.channel.baseUrl, authenticated = true, get = false } = {}) {
    if (this.stopped) { throw Error('微信渠道已停止'); }
    const headers = { ...appHeaders };
    if (!get) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (authenticated) { headers.Authorization = `Bearer ${this.channel.botToken}`; }
    }
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(40000)]);
    const response = await this.fetch(`${trustedBase(base)}${path}`, { method: get ? 'GET' : 'POST', headers, signal,
      ...(get ? {} : { body: JSON.stringify(authenticated ? { ...body, base_info: baseInfo } : body) }) });
    if (!response.ok) { throw Error(`微信 HTTP ${response.status}`); }
    // Native message identifiers are uint64; parsing a rounded Number would break deduplication and source routing.
    const result = JSON.parse(await response.text(), (key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value)
      ? context.source : value);
    if (result.ret === -14 || result.errcode === -14) {
      this.authExpired = true;
      this.status({ state: 'login_required', error: '微信登录已失效，请重新扫码' });
      throw Error('微信登录已失效');
    }
    if (result.ret || result.errcode) { throw Error('微信服务拒绝请求'); }
    return result;
  }

  async pollOnce() {
    const result = await this.request('/ilink/bot/getupdates', { get_updates_buf: this.channel.cursor || '' });
    for (const message of result.msgs || []) {
      if (this.stopped) { return; }
      if (message.message_type !== 1 || message.message_state !== 2 || message.group_id || !message.context_token) { continue; }
      const text = (message.item_list || []).filter(item => item.type === 1).map(item => item.text_item?.text || '').join('\n');
      await this.receive({ messageId: String(message.message_id), chatId: message.from_user_id, chatType: 'private', senderId: message.from_user_id,
        text, sentAt: Number(message.create_time_ms), replyContext: { contextToken: message.context_token } });
    }
    if (!this.stopped && result.get_updates_buf) {
      await this.credentials({ cursor: result.get_updates_buf });
      this.channel.cursor = result.get_updates_buf;
    }
  }

  async monitor() {
    while (!this.stopped && !this.authExpired) {
      try { await this.pollOnce(); }
      catch (error) {
        if (this.stopped || this.authExpired) { break; }
        this.report?.('weixin-receive', error);
        this.status({ state: 'connecting', error: '微信收取暂不可用，正在重连' });
        await delay(2000, undefined, { signal: this.controller.signal }).catch(() => {});
      }
      if (!this.stopped && !this.authExpired) { await delay(100, undefined, { signal: this.controller.signal }).catch(() => {}); }
    }
  }

  async start() {
    if (!this.channel.botToken) { this.status({ state: 'login_required' }); return; }
    this.status({ state: 'connected', account: this.channel.botId });
    this.monitoring ||= this.monitor();
  }

  async login() {
    if (this.loggingIn) { return; }
    if (this.channel.botToken) { throw Error('请先新建机器人渠道再更换微信账号，避免复用旧回复上下文'); }
    const result = await this.request('/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { base: apiRoot, authenticated: false });
    const { default: qr } = await import('qrcode');
    this.status({ state: 'scan', qrDataUrl: await qr.toDataURL(result.qrcode_img_content) });
    this.loggingIn = this.pollLogin(result.qrcode).finally(() => { this.loggingIn = null; });
    this.loggingIn.catch(error => { if (!this.stopped) { this.report?.('weixin-login', error); this.status({ state: 'error', error: '扫码登录失败，请重新获取二维码' }); } });
  }

  async pollLogin(qrcode) {
    let base = apiRoot;
    const deadline = Date.now() + 180000;
    while (!this.stopped && Date.now() < deadline) {
      const query = new URLSearchParams({ qrcode, ...(this.verifyCode ? { verify_code: this.verifyCode } : {}) });
      this.verifyCode = null;
      const result = await this.request(`/ilink/bot/get_qrcode_status?${query}`, null, { base, get: true });
      if (result.status === 'confirmed') {
        const patch = { botToken: result.bot_token, botId: result.ilink_bot_id, baseUrl: trustedBase(result.baseurl), cursor: '' };
        await this.credentials(patch);
        if (this.stopped) { return; }
        Object.assign(this.channel, patch);
        this.authExpired = false;
        await this.start();
        return;
      }
      if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) { throw Error('二维码过期或绑定不可用'); }
      if (result.status === 'need_verifycode') { this.status({ state: 'verify_required' }); }
      if (result.status === 'scaned_but_redirect' && result.redirect_host) { base = trustedBase(`https://${result.redirect_host.replace(/^https:\/\//, '')}`); }
      await delay(1500, undefined, { signal: this.controller.signal });
    }
    if (!this.stopped) { this.status({ state: 'login_required', error: '二维码已过期' }); }
  }

  verify(code) { this.verifyCode = String(code); }

  async send({ source, text, clientId }) {
    if (!source.replyContext?.contextToken || this.authExpired) { throw Error('微信回复上下文或登录已失效'); }
    await this.request('/ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: source.senderId, client_id: clientId,
      message_type: 2, message_state: 2, context_token: source.replyContext.contextToken, item_list: [{ type: 1, text_item: { text } }] } });
    return {};
  }

  async stop() {
    this.stopped = true;
    this.controller.abort();
    await Promise.allSettled([this.monitoring, this.loggingIn]);
  }
}
