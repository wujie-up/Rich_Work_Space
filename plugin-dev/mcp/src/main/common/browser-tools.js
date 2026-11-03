import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const id = 'mcp.browser.control';
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const inputSchema = { type: 'object', properties: {
  action: { type: 'string', enum: ['open', 'tabs', 'snapshot', 'click', 'fill', 'press', 'select', 'scroll', 'screenshot', 'close', 'request_user'] },
  tabId: { type: 'string' }, url: { type: 'string', maxLength: 4000 },
  role: { type: 'string', maxLength: 80 }, name: { type: 'string', maxLength: 1000 }, selector: { type: 'string', maxLength: 1000 },
  text: { type: 'string', maxLength: 100000 }, key: { type: 'string', maxLength: 80 },
  amount: { type: 'integer', minimum: -4000, maximum: 4000 }
}, required: ['action'], additionalProperties: false };

export class BrowserTools {
  constructor(context, options = {}) {
    this.context = context;
    this.chromium = options.chromium;
    this.pages = new Map();
    this.active = new Set();
    this.key = `plugin-data/${context.pluginId}/browser-state.json`;
  }

  async load() {
    await this.context.capabilities.register({ id, version: 1, title: '浏览器 · 页面操作', inputSchema,
      description: '操作插件独立的 Chrome 浏览器，不接管用户已有窗口。open(url) 打开 HTTP(S) 页面并返回 tabId 和页面结构；'
        + 'tabs 列出标签页。其余操作必须携带 tabId：snapshot 读取带角色和名称的页面结构；'
        + 'click/fill/press/select 使用 role + name（精确名称）或 selector 定位唯一元素；fill(text) 填写，press(key) 按键，'
        + 'select(text) 选择值；scroll(amount) 向下滚动，负数向上；screenshot 查看截图；close 关闭标签页。'
        + '需要登录、授权、验证码或用户决定时，调用 request_user(tabId,text) 弹窗等待用户完成，不得代替用户授权。',
      outputSchema: { type: 'object' }, effects: ['browser.control'], confirmation: 'policy',
      execution: { timeoutMs: 600000, cancellable: true, retry: 'never', resource: 'browser' }, source: { builtin: true } },
    (input, context) => this.invoke(input, context.signal));
    this.registered = true;
  }

  // The packaged runtime and an owned browser process keep this independent of the host's development dependencies.
  async launch() {
    try {
      this.chromium ||= (await import('../../../dist/browser/index.mjs')).chromium;
      this.server = await this.chromium.launchServer({ channel: 'chrome', headless: false, timeout: 20000 });
      const server = this.server;
      server.once('close', () => {
        if (this.server !== server) { return; }
        this.server = undefined;
        this.session = undefined;
        this.opening = undefined;
        this.pages.clear();
        this.context.ownProcesses([]);
      });
      this.context.ownProcesses([this.server.process().pid]);
      const browser = await this.chromium.connect(this.server.wsEndpoint());
      const storageState = await this.context.storage.readJson(this.key, undefined);
      this.session = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(storageState ? { storageState } : {}) });
      this.session.on?.('page', page => this.trackPage(page));
      console.info('[mcp:browser-started]', { pluginId: this.context.pluginId, pid: this.server.process().pid });
      return this.session;
    } catch (error) {
      await this.server?.close();
      this.server = undefined;
      this.opening = undefined;
      this.context.ownProcesses([]);
      console.error('[mcp:browser-start-failed]', { pluginId: this.context.pluginId }, error);
      throw Error('无法启动独立浏览器，请确认已安装 Google Chrome。' + error.message, { cause: error });
    }
  }

  page(tabId) {
    const page = this.pages.get(tabId);
    if (!page) { throw Error('标签页不存在，请先 open 或 tabs 获取 tabId'); }
    return page;
  }

  // Include target=_blank and login popups in the same tab inventory.
  trackPage(page) {
    const existing = [...this.pages].find(([, value]) => value === page);
    if (existing) { return existing[0]; }
    const tabId = randomUUID();
    this.pages.set(tabId, page);
    page.once('close', () => this.pages.delete(tabId));
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout?.(20000);
    return tabId;
  }

  locator(page, input) {
    if (input.selector) { return page.locator(input.selector); }
    if (input.role && input.name !== undefined) { return page.getByRole(input.role, { name: input.name, exact: true }); }
    throw Error('元素操作需要 role + name 或 selector');
  }

  async snapshot(tabId, page) {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 20000 });
    return textResult({ tabId, url: page.url(), title: await page.title(), snapshot: snapshot.slice(0, 24000),
      truncated: snapshot.length > 24000 });
  }

  // Login and decisions stay with the user, even when the background Agent has full execution access.
  async requestUser(input, signal) {
    if (!input.text?.trim()) { throw Error('请说明需要用户完成的操作'); }
    const request = await this.context.host.messages.request({ key: randomUUID(), title: '浏览器需要用户操作',
      question: input.text, required: true, placement: 'center', optionsOnly: true,
      options: ['已完成，继续', '取消本次操作'] });
    try {
      while (true) {
        signal.throwIfAborted();
        const current = await this.context.host.messages.get(request.id);
        if (current.state === 'answered' && current.answer.text === '已完成，继续') { return textResult({ confirmed: true }); }
        if (current.state !== 'pending') { throw Error('用户取消浏览器操作'); }
        await delay(300, undefined, { signal });
      }
    } finally {
      await this.context.host.messages.cancel(request.id);
    }
  }

  async execute(input, signal) {
    signal.throwIfAborted();
    if (input.action === 'request_user') {
      await this.page(input.tabId).bringToFront();
      return this.requestUser(input, signal);
    }
    if (input.action === 'tabs') {
      return textResult({ tabs: await Promise.all([...this.pages].map(async ([tabId, page]) =>
        ({ tabId, url: page.url(), title: await page.title() }))) });
    }
    if (input.action === 'open') {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol)) { throw Error('只支持 HTTP(S) 网页'); }
      const session = await (this.opening ||= this.launch());
      signal.throwIfAborted();
      if (!input.tabId) {
        const page = await session.newPage();
        input = { ...input, tabId: this.trackPage(page) };
      }
    }
    const page = this.page(input.tabId);
    const cancel = () => page.close().catch(error => console.error('[mcp:browser-cancel-failed]',
      { pluginId: this.context.pluginId, tabId: input.tabId }, error));
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      switch (input.action) {
        case 'open': await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); break;
        case 'snapshot': break;
        case 'click': await this.locator(page, input).click(); break;
        case 'fill': await this.locator(page, input).fill(input.text); break;
        case 'press': await this.locator(page, input).press(input.key); break;
        case 'select': await this.locator(page, input).selectOption(input.text); break;
        case 'scroll': await page.mouse.wheel(0, input.amount ?? 600); break;
        case 'screenshot': return { content: [{ type: 'image', mimeType: 'image/png',
          data: (await page.screenshot({ type: 'png' })).toString('base64') }] };
        case 'close':
          await page.close();
          this.pages.delete(input.tabId);
          return textResult({ tabId: input.tabId, closed: true });
        default: throw Error('不支持的浏览器操作');
      }
      return await this.snapshot(input.tabId, page);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async invoke(input, signal) {
    if (this.closed) { throw Error('浏览器工具已停止'); }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let finish;
    const active = { controller, done: new Promise(resolve => { finish = resolve; }) };
    this.active.add(active);
    let cancel;
    const aborted = new Promise((resolve, reject) => {
      cancel = () => reject(combined.reason);
      combined.addEventListener('abort', cancel, { once: true });
    });
    console.info('[mcp:browser-call]', { pluginId: this.context.pluginId, action: input.action, tabId: input.tabId });
    try {
      combined.throwIfAborted();
      return await Promise.race([this.execute(input, combined), aborted]);
    } catch (error) {
      console.error('[mcp:browser-call-failed]', { pluginId: this.context.pluginId, action: input.action, tabId: input.tabId }, error);
      throw error;
    } finally {
      combined.removeEventListener('abort', cancel);
      this.active.delete(active);
      finish();
    }
  }

  async close() {
    this.closed = true;
    for (const active of this.active) { active.controller.abort(); }
    await Promise.all([...this.active].map(active => active.done));
    // Wait for an in-flight launch before releasing the owned process.
    try {
      if (this.opening) {
        await this.opening;
        await this.context.storage.writeJson(this.key, await this.session.storageState());
      }
    } catch (error) {
      console.error('[mcp:browser-state-save-failed]', { pluginId: this.context.pluginId }, error);
    } finally {
      try {
        await this.server?.close();
      } finally {
        this.server = undefined;
        this.pages.clear();
        this.context.ownProcesses([]);
        if (this.registered) { await this.context.capabilities.unregister(id, 1); }
        this.registered = false;
      }
    }
  }
}
