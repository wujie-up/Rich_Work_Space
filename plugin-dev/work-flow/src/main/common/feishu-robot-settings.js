import { fail } from './errors.js';

export function validFeishuWebhook(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('INVALID_ARGUMENT', '请填写有效的飞书机器人 Webhook');
  }
  if (url.origin !== 'https://open.feishu.cn' || url.username || url.password || url.search || url.hash
    || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
    throw fail('INVALID_ARGUMENT', 'Webhook 必须是 open.feishu.cn 的 HTTPS 群机器人地址，不含查询参数');
  }
  return url.href;
}

// Outgoing webhook robots are independent of the App ID/App Secret used for incoming group messages.
export class FeishuRobotSettings {
  #pending = Promise.resolve();

  constructor({ storage, pluginId }) {
    Object.assign(this, { storage, pluginId });
  }

  #path() {
    return `plugin-data/${this.pluginId}/feishu-robot.json`;
  }

  async #stored() {
    try {
      return await this.storage.readJson(this.#path(), { webhook: '', key: '' });
    } catch {
      throw fail('FEISHU_CONFIG_READ_FAILED', '无法读取飞书机器人配置，请检查插件数据文件');
    }
  }

  async read() {
    await this.#pending;
    const { webhook, key } = await this.#stored();
    return { configured: Boolean(webhook && key), hasKey: Boolean(key),
      webhookHint: webhook ? `open.feishu.cn/…/****${webhook.slice(-4)}` : '' };
  }

  async snapshot() {
    await this.#pending;
    const stored = await this.#stored();
    if (!stored.webhook || !stored.key) {
      throw fail('FEISHU_NOT_CONFIGURED', '请在飞书通知节点下方保存机器人 Webhook 和签名密钥');
    }
    return { webhook: stored.webhook, key: stored.key };
  }

  save(input) {
    const task = this.#pending.then(async () => {
      const previous = await this.#stored();
      const webhook = validFeishuWebhook(String(input?.webhook || previous.webhook || '').trim());
      const key = String(input?.key || previous.key || '').trim();
      if (!key || key.length > 512) {
        throw fail('INVALID_ARGUMENT', '请填写有效的飞书机器人签名密钥');
      }
      await this.storage.writeJson(this.#path(), { webhook, key });
    });
    this.#pending = task.catch(() => undefined);
    return task.then(() => this.read());
  }
}
