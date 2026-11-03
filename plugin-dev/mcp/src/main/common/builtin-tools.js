import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FeishuDocuments } from './feishu-documents.js';
import computer from '../os/index.js';

const defaults = { feishuEnabled: true, computerEnabled: true, appId: '', appSecret: '', userAccessToken: '' };
const computerSchema = { type: 'object', properties: {
  action: { type: 'string', enum: ['screenshot', 'click', 'type', 'key', 'scroll', 'open'] },
  bundleId: { type: 'string', minLength: 1, maxLength: 255,
    description: '目标 macOS App 的 bundle ID，例如 com.google.Chrome。每次截图或输入均指定，确认后会重新激活目标；省略则使用当前前台 App。' },
  x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
  text: { type: 'string', maxLength: 10000 }, key: { type: 'string', maxLength: 80 },
  amount: { type: 'integer', minimum: -2000, maximum: 2000 }, url: { type: 'string', maxLength: 4000 }
}, required: ['action'], additionalProperties: false };

export class BuiltinTools {
  constructor(context, options = {}) {
    this.context = context;
    this.computer = options.computer || computer;
    this.documents = options.documents || new FeishuDocuments();
    this.registered = new Set();
    this.active = new Set();
    this.key = `plugin-data/${context.pluginId}/builtin-tools.json`;
  }

  async read() { return { ...defaults, removed: false, ...await this.context.storage.readJson(this.key, {}) }; }

  async status() { return { removed: (await this.read()).removed }; }

  async remove() {
    const config = await this.read();
    await this.context.storage.writeJson(this.key, { ...config, removed: true, feishuEnabled: false, computerEnabled: false });
    await this.load();
    await Promise.all([...this.active].map(active => active.done));
    console.info('[mcp:builtin-removed]', { pluginId: this.context.pluginId });
  }

  async save(input) {
    if ((await this.read()).removed) { throw Error('内置工具已删除'); }
    if (!input || Object.keys(defaults).some(key => typeof input[key] !== typeof defaults[key])
      || ['appId', 'appSecret', 'userAccessToken'].some(key => input[key].length > 4000)) {
      throw Error('飞书与电脑工具配置无效');
    }
    const config = Object.fromEntries(Object.keys(defaults).map(key => [key, typeof input[key] === 'string' ? input[key].trim() : input[key]]));
    await this.context.storage.writeJson(this.key, config);
    await this.load();
    console.info('[mcp:builtin-settings]', { pluginId: this.context.pluginId,
      feishuEnabled: config.feishuEnabled, computerEnabled: config.computerEnabled });
  }

  async load() {
    const config = await this.read();
    // Built-ins are workbench capabilities, not external MCP connection selections.
    const definitions = [
      ['mcp.feishu.document.read', config.feishuEnabled, 'feishu-documents', '飞书文档 · 读取正文',
        '读取飞书或 Lark 的 docx / wiki 文档链接。需要应用文档权限或用户令牌；权限不足时请求用户确认。只在调用时读取，不修改原文。',
        { type: 'object', properties: { url: { type: 'string', maxLength: 4000 } }, required: ['url'], additionalProperties: false }, ['document.read']],
      ['mcp.computer.control', config.computerEnabled && this.computer.supported, 'computer', '电脑操作 · macOS',
        '操作用户电脑：screenshot 查看主屏幕；click(x,y) 使用截图像素坐标；type(text) 输入文字；key(key) 按键如 CMD+L、ENTER；'
          + 'scroll(amount) 正数向上、负数向下；open(url) 打开网页。bundleId 指定目标 App（如 com.google.Chrome），'
          + '每次截图和输入均应指定，避免确认弹窗改变焦点；不指定时沿用当前前台 App，open 使用默认浏览器。'
          + '操作前先截图确认目标。系统授权不足时弹窗请求用户操作。',
        computerSchema, ['computer.control']]
    ];
    for (const [id, enabled, serviceId, title, description, inputSchema, effects] of definitions) {
      if (enabled && !config.removed && !this.registered.has(id)) {
        await this.context.capabilities.register({ id, version: 1, title, description, inputSchema, outputSchema: { type: 'object' },
          effects, confirmation: 'policy', execution: { timeoutMs: 600000, cancellable: true, retry: 'never',
            ...(serviceId === 'computer' ? { resource: 'computer' } : {}) }, source: { builtin: true } },
        (input, context) => this.invoke(id, input, context.signal));
        this.registered.add(id);
      } else if ((!enabled || config.removed) && this.registered.has(id)) {
        await this.context.capabilities.unregister(id, 1);
        this.registered.delete(id);
        for (const active of this.active) {
          if (active.id === id) { active.controller.abort(); }
        }
      }
    }
  }

  // Required requests remain visible; only explicit answers or cancellation release the invocation.
  async confirm(title, question, signal) {
    signal.throwIfAborted();
    const request = await this.context.host.messages.request({ key: randomUUID(), title, question,
      required: true, placement: 'center', optionsOnly: true, options: ['已完成授权，重试', '取消本次操作'] });
    console.info('[mcp:builtin-authorization]', { pluginId: this.context.pluginId, requestId: request.id });
    try {
      while (true) {
        signal.throwIfAborted();
        const current = await this.context.host.messages.get(request.id);
        if (current.state === 'answered') {
          if (current.answer.text === '已完成授权，重试') { return; }
          throw Error('用户取消本次操作');
        }
        if (current.state !== 'pending') { throw Error('授权请求已取消'); }
        await delay(300, undefined, { signal });
      }
    } finally {
      await this.context.host.messages.cancel(request.id);
    }
  }

  async invoke(id, input, signal) {
    const controller = new AbortController();
    let finished;
    const active = { id, controller, done: new Promise(resolve => { finished = resolve; }) };
    this.active.add(active);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    console.info('[mcp:builtin-call]', { pluginId: this.context.pluginId, capabilityId: id, action: input.action, bundleId: input.bundleId });
    try {
      if ((await this.read()).removed) { throw Error('内置工具已删除'); }
      combined.throwIfAborted();
      if (id === 'mcp.computer.control') {
        const permissions = await this.computer.permissions(combined);
        if (!permissions.screen || !permissions.accessibility) {
          await this.confirm('电脑操作需要系统授权', '请在 macOS 系统设置 → 隐私与安全性中，允许 DeckPg 使用屏幕录制和辅助功能。'
            + '确认后会请求系统授权并重试；未授权不会执行操作。', combined);
          await this.computer.authorize(combined);
          const permitted = await this.computer.permissions(combined);
          if (!permitted.screen || !permitted.accessibility) { throw Error('系统授权尚未完成，请完成授权后重新调用电脑工具'); }
        }
        combined.throwIfAborted();
        return await this.computer.execute(input, combined);
      }
      while (true) {
        combined.throwIfAborted();
        try {
          return await this.documents.read(input, await this.read(), combined);
        } catch (error) {
          if (error.code !== 'FEISHU_AUTH_REQUIRED') { throw error; }
          await this.confirm('飞书文档需要授权', error.message, combined);
        }
      }
    } catch (error) {
      console.error('[mcp:builtin-call-failed]', { pluginId: this.context.pluginId, capabilityId: id }, error);
      throw error;
    } finally {
      this.active.delete(active);
      finished();
    }
  }

  async close() {
    for (const active of this.active) { active.controller.abort(); }
    await Promise.all([...this.active].map(active => active.done));
    for (const id of this.registered) { await this.context.capabilities.unregister(id, 1); }
    this.registered.clear();
  }
}
