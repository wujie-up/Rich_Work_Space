import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { compactSnapshot, safeUrl, snapshotId } from './observation.js';
import { logError } from './log.js';
import { localHtmlUrl } from './html-file.js';

export class BrowserSession {
  constructor({ root, platform, chromium, executable }) {
    Object.assign(this, { root, platform, chromium, executable });
    this.entries = new Map();
    this.queue = Promise.resolve();
    this.stopping = false;
  }

  // A shared visible session must serialize Agent calls, including observation/ref generation.
  run(operation, call = {}) {
    const task = this.queue.then(async () => {
      this.checkCall(call);
      if (this.stopping) {
        throw Error('浏览器正在关闭');
      }
      return operation();
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  checkCall({ signal, deadline } = {}) {
    if (signal?.aborted || (deadline && Date.now() >= deadline)) {
      throw Error('操作已取消或超时；已执行的网页操作不会撤销');
    }
  }

  async start() {
    if (this.context) {
      return;
    }
    const profile = join(this.root, 'profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const owned = await this.platform.launch({ executable: this.executable, profile });
    this.process = owned;
    try {
      this.browser = await this.chromium.connectOverCDP(owned.endpoint, { timeout: 10000 });
      this.context = this.browser.contexts()[0];
      this.context.setDefaultTimeout(2500);
      this.context.setDefaultNavigationTimeout(12000);
      this.context.pages().forEach(page => this.track(page));
      this.context.on('page', page => this.track(page));
      owned.done.then(() => {
        if (this.process === owned) {
          this.entries.clear();
          this.process = null;
          this.context = null;
          this.browser = null;
        }
      });
      console.info('[ai-browser] browser started');
    } catch (error) {
      await owned.close();
      this.process = null;
      throw error;
    }
  }

  track(page) {
    if ([...this.entries.values()].some(entry => entry.page === page)) {
      return;
    }
    const entry = { id: randomUUID().slice(0, 8), page, epoch: 0, snapshot: null, title: '' };
    this.entries.set(entry.id, entry);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        entry.epoch++;
        entry.snapshot = null;
      }
    });
    page.on('close', () => this.entries.delete(entry.id));
    page.on('domcontentloaded', () => {
      page.title().then(title => { entry.title = title.slice(0, 160); }).catch(error => {
        entry.title = '';
        logError(`title unavailable tabId=${entry.id}`, error);
      });
    });
    page.on('crash', () => {
      entry.snapshot = null;
      console.error(`[ai-browser] tab crashed tabId=${entry.id}`);
    });
    // Do not auto-confirm JavaScript dialogs or leave Agent clicks hanging behind one.
    page.on('dialog', dialog => {
      dialog.dismiss().catch(error => logError(`dialog dismiss failed tabId=${entry.id}`, error));
    });
  }

  entry(tabId) {
    const entry = tabId ? this.entries.get(tabId) : this.entries.values().next().value;
    if (!entry || entry.page.isClosed()) {
      throw Error('标签不存在，请先使用 browser_act open/newTab 或 browser_tabs');
    }
    return entry;
  }

  page(tabId) {
    return this.entry(tabId).page;
  }

  async tabs() {
    return [...this.entries.values()].map(({ id, page, title }) => ({ id, title, url: page.url().slice(0, 1000) }));
  }

  observe(input = {}, call = {}) {
    return this.run(() => this.read(input, call), call);
  }

  openHtml(input, call = {}) {
    return this.run(async () => {
      const url = await localHtmlUrl(input);
      this.checkCall(call);
      await this.start();
      // A preview must not navigate away from an existing user or Agent task.
      const page = this.context.pages().find(page => page.url() === 'about:blank') || await this.context.newPage();
      this.track(page);
      const entry = [...this.entries.values()].find(entry => entry.page === page);
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 12000 });
        await page.bringToFront();
        console.info(`[ai-browser] HTML preview opened tabId=${entry.id}`);
        return { tabId: entry.id, completed: 1 };
      } catch (error) {
        logError(`HTML preview failed tabId=${entry.id}`, error);
        throw Error('HTML 预览失败，请检查文件与相对资源；浏览器中可能已打开该标签');
      }
    }, call);
  }

  async read({ tabId, mode = 'elements', selector, query = '', offset = 0, maxChars = 4000, since } = {}, call = {}) {
    if (!['elements', 'text', 'tree'].includes(mode)) {
      throw Error('mode 只允许 elements/text/tree');
    }
    const entry = this.entry(tabId);
    const target = entry.page.locator(selector || 'body');
    const epoch = entry.epoch;
    const source = mode === 'text' ? await target.innerText({ timeout: 2500 })
      : await target.ariaSnapshot({ mode: 'ai', timeout: 2500, signal: call.signal });
    this.checkCall(call);
    if (epoch !== entry.epoch) {
      throw Error('读取期间页面已跳转，请重新读取');
    }
    const compact = compactSnapshot(source, { mode, query, offset, maxChars });
    const id = snapshotId([entry.id, entry.epoch, entry.page.url(), mode, selector, query], source);
    // Refs are valid only for the latest ARIA snapshot and its document generation.
    entry.snapshot = mode === 'text' ? null : { id, refs: new Set([...source.matchAll(/\[ref=(\w+)\]/g)].map(match => match[1])) };
    const base = { tabId: entry.id, snapshotId: id };
    if (!offset && since === id) {
      return { ...base, unchanged: true };
    }
    return { ...base, url: entry.page.url().slice(0, 1000), ...compact,
      ...(compact.totalChars === 0 ? { hint: '无匹配元素，可尝试 mode=text/tree 或 selector 缩小范围' } : {}) };
  }

  act(input, call = {}) {
    return this.run(async () => {
      this.validateSteps(input);
      await this.start();
      this.checkCall(call);
      let entry = this.entry(input.tabId);
      if (input.steps.some(step => step.ref) && (!entry.snapshot || input.snapshotId !== entry.snapshot.id)) {
        throw Error('快照已失效或缺少 snapshotId，请重新 observe 后使用 ref');
      }
      let completed = 0;
      for (const step of input.steps) {
        this.checkCall(call);
        try {
          entry = await this.step(entry, step, input.snapshotId);
          completed++;
        } catch (error) {
          logError(`action failed tabId=${entry.id} step=${completed} op=${step.op}`, error);
          return { tabId: entry.id, completed, failedStep: completed,
            error: '操作失败；可能有部分网页副作用，请先观察当前页面再决定是否继续。', code: error.name || 'ACTION_FAILED' };
        }
      }
      console.info(`[ai-browser] actions completed tabId=${entry.id} count=${completed}`);
      return { tabId: entry.id, completed };
    }, call);
  }

  validateSteps({ steps }) {
    const operations = ['open', 'newTab', 'closeTab', 'focus', 'back', 'forward', 'reload', 'click', 'fill', 'press', 'select', 'scroll'];
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12) {
      throw Error('每批需要 1–12 个操作');
    }
    for (const step of steps) {
      if (!operations.includes(step.op)) {
        throw Error('不支持此浏览器操作');
      }
      if (step.op === 'open' && (typeof step.url !== 'string' || !step.url)) {
        throw Error('打开网页需要 url');
      }
      if (['open', 'newTab'].includes(step.op) && step.url !== undefined) {
        safeUrl(step.url);
      }
      if (['click', 'fill', 'select'].includes(step.op) && !step.ref && !step.selector) {
        throw Error('此操作需要 ref 或 selector');
      }
      if (['fill', 'press', 'select'].includes(step.op) && typeof step.value !== 'string') {
        throw Error('此操作需要字符串 value');
      }
      if (step.op === 'scroll' && (!Number.isFinite(step.y) || Math.abs(step.y) > 10000)) {
        throw Error('滚动距离必须在 -10000–10000 之间');
      }
    }
  }

  async step(entry, step, observedId) {
    const { page } = entry;
    if (step.ref && (!entry.snapshot?.refs.has(step.ref) || entry.snapshot.id !== observedId)) {
      throw Error('元素引用已失效，请重新读取页面');
    }
    const target = step.ref ? page.getByRef(step.ref) : step.selector ? page.locator(step.selector) : null;
    const navigation = { waitUntil: 'domcontentloaded', timeout: 12000 };
    switch (step.op) {
      case 'open':
        await page.goto(safeUrl(step.url), navigation);
        break;
      case 'newTab': {
        const created = await this.context.newPage();
        this.track(created);
        entry = [...this.entries.values()].find(item => item.page === created);
        if (step.url) {
          await created.goto(safeUrl(step.url), navigation);
        }
        await created.bringToFront();
        break;
      }
      case 'closeTab':
        await page.close();
        break;
      case 'focus':
        await page.bringToFront();
        break;
      case 'back':
        await page.goBack(navigation);
        break;
      case 'forward':
        await page.goForward(navigation);
        break;
      case 'reload':
        await page.reload(navigation);
        break;
      case 'click':
        await target.click();
        break;
      case 'fill':
        await target.fill(step.value);
        break;
      case 'press':
        await (target ? target.press(step.value) : page.keyboard.press(step.value));
        break;
      case 'select':
        await target.selectOption(step.value);
        break;
      case 'scroll':
        await page.mouse.wheel(0, step.y);
        break;
      default:
        throw Error('不支持此浏览器操作');
    }
    return entry;
  }

  screenshot({ tabId } = {}, call = {}) {
    return this.run(async () => {
      const image = await this.page(tabId).screenshot({ type: 'jpeg', quality: 45, fullPage: false, timeout: 5000 });
      if (image.length > 650000) {
        throw Error('截图过大，请缩小浏览器窗口或优先使用 observe');
      }
      return { content: [{ type: 'image', mimeType: 'image/jpeg', data: image.toString('base64') }] };
    }, call);
  }

  async close() {
    this.stopping = true;
    await this.queue;
    const owned = this.process;
    try {
      if (this.browser?.isConnected()) {
        const cdp = await this.browser.newBrowserCDPSession();
        await cdp.send('Browser.close').catch(error => logError('graceful close failed', error));
        // Browser.close acknowledges before profile data is flushed; wait before escalating to a signal.
        await Promise.race([owned.done, delay(5000)]);
      }
    } finally {
      await owned?.close();
      this.process = null;
      this.browser = null;
      this.context = null;
      this.entries.clear();
      this.stopping = false;
    }
  }
}
