import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { validWorkItemQuery } from '../../shared/query-policy.js';

const fail = (code, message) => Object.assign(Error(message), { code });

function bounded(operation, timeoutMs, signals = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) { signal?.removeEventListener('abort', abort); }
      callback(value);
    };
    const abort = () => finish(reject, fail('CANCELLED', '查询已取消'));
    const timer = setTimeout(() => finish(reject, fail('TIMEOUT', '网页登录请求超时，请重试')), timeoutMs);
    for (const signal of signals) {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); }
    }
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export class BrowserSession {
  constructor({ root, platform, connect = endpoint => chromium.connectOverCDP(endpoint, { timeout: 10000 }), requestTimeoutMs = 12000 }) {
    Object.assign(this, { root, platform, connect, requestTimeoutMs });
    this.state = 'closed';
    this.epoch = randomUUID();
    this.lifetime = new AbortController();
  }

  rotate() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.epoch = randomUUID();
  }

  invalidate(page, lifetime) {
    if (this.page === page && this.lifetime === lifetime && !this.closing) {
      this.rotate();
      this.state = 'needs-login';
      this.error = null;
    }
  }

  status() {
    return { state: this.state, epoch: this.epoch, error: this.error || null };
  }

  open(site) {
    const origin = new URL(site).origin;
    if (!site.startsWith('https://') || origin !== site.replace(/\/$/, '')) {
      throw fail('INVALID_CONFIG', '登录站点必须是 HTTPS 站点地址');
    }
    if (this.closing) {
      return this.status();
    }
    if (this.opening) {
      if (this.site !== origin) {
        throw fail('BROWSER_BUSY', '正在打开登录窗口，请稍后切换站点');
      }
      return this.status();
    }
    if (this.site === origin && this.page && !this.page.isClosed()) {
      if (this.state === 'error') {
        this.state = 'needs-login';
        this.error = null;
      }
      this.page.bringToFront().catch(() => {});
      return this.status();
    }
    this.state = 'opening';
    this.site = origin;
    this.error = null;
    this.rotate();
    this.opening = this.launch(origin).catch(async () => {
      await this.shutdown();
      this.state = 'error';
      this.error = '无法打开登录窗口，请检查是否已安装 Chrome，或重试登录';
    }).finally(() => { this.opening = null; });
    return this.status();
  }

  async launch(origin) {
    await this.shutdown();
    this.lifetime = new AbortController();
    this.site = origin;
    this.profile = join(this.root, createHash('sha256').update(origin).digest('hex').slice(0, 16));
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    this.process = await this.platform.launch(this.profile);
    this.browser = await this.connect(this.process.endpoint);
    this.context = this.browser.contexts()[0];
    this.page = this.context.pages()[0] || await this.context.newPage();
    const owned = this.process;
    owned.done?.then(() => {
      if (this.process === owned) {
        this.state = 'closed';
        this.rotate();
        this.page = null;
        this.process = null;
        this.browser = null;
        this.context = null;
      }
    });
    await this.page.goto(`${origin}/pjm/projects`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    this.state = this.closing ? 'closing' : 'needs-login';
    await this.page.bringToFront();
  }

  query(site, body, signal) {
    if (!validWorkItemQuery(body)) { throw fail('INVALID_ARGUMENT', '按月查询条件无效'); }
    return this.read(site, '/api/agile/work-items', body, signal, true);
  }

  async read(site, path, params = {}, signal, query = false) {
    if (this.opening) {
      await this.opening;
    }
    if (!this.site) {
      throw fail('LOGIN_REQUIRED', '请先打开独立窗口并登录 PingCode');
    }
    if (new URL(site).origin !== this.site) {
      throw fail('SITE_CHANGED', '登录站点已更改，请重新打开登录窗口');
    }
    if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(path)
      || !(path.startsWith('/api/agile/') || path === '/api/typhon/account/me') || (query && path !== '/api/agile/work-items')) {
      throw fail('INVALID_ARGUMENT', '网页读取请求无效');
    }
    const page = this.page;
    const lifetime = this.lifetime;
    if (!page || page.isClosed() || new URL(page.url()).origin !== this.site) {
      this.invalidate(page, lifetime);
      throw fail('LOGIN_REQUIRED', '请在独立窗口中完成 PingCode 登录，然后检查登录状态');
    }
    if (signal?.aborted) {
      throw fail('CANCELLED', '查询已取消');
    }
    const id = randomUUID();
    const abort = async () => {
      try {
        await page.evaluate(id => globalThis.__pingcodeReads?.get(id)?.abort(), id);
      } catch {
        // The Node-side cancellation is authoritative even when the browser cannot answer.
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    lifetime.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await bounded(page.evaluate(async ({ site, path, params, id, query }) => {
        if (location.origin !== site || (query && path !== '/api/agile/work-items')) {
          return { failure: 'site' };
        }
        const controller = new AbortController();
        globalThis.__pingcodeReads ||= new Map();
        globalThis.__pingcodeReads.set(id, controller);
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const url = new URL(path, site);
          for (const [key, value] of Object.entries(query ? {} : params)) {
            if (value !== undefined && value !== '') {
              url.searchParams.set(key, String(value));
            }
          }
          const response = await fetch(url, { method: query ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error',
            signal: controller.signal, headers: { Accept: 'application/json', ...(query ? { 'Content-Type': 'application/json' } : {}) },
            ...(query ? { body: JSON.stringify(params) } : {}) });
          return { status: response.status, body: await response.json().catch(() => null) };
        } catch {
          return { failure: controller.signal.aborted ? 'aborted' : 'network' };
        } finally {
          clearTimeout(timer);
          globalThis.__pingcodeReads.delete(id);
        }
      }, { site: this.site, path, params, id, query }), this.requestTimeoutMs, [signal, lifetime.signal]);
      if (signal?.aborted) {
        throw fail('CANCELLED', '查询已取消');
      }
      if (this.page !== page || this.lifetime !== lifetime || this.closing) {
        throw fail('CANCELLED', '登录状态已更改，请重新查询');
      }
      if (result.failure === 'site' || new URL(page.url()).origin !== this.site
        || result.status === 401 || result.body?.code === 401) {
        this.invalidate(page, lifetime);
        throw fail('LOGIN_REQUIRED', '网页登录已失效，请重新登录');
      }
      if (result.status === 403) {
        throw fail('FORBIDDEN', '当前账号无权读取这些数据');
      }
      if (result.status === 429) {
        throw fail('RATE_LIMITED', '请求过于频繁，请稍后重试');
      }
      if (result.failure) {
        throw fail('WEB_REQUEST_FAILED', result.failure === 'aborted' ? '网页请求超时，请重试' : '网页请求失败，请检查登录和网络');
      }
      if (result.status !== 200 || !result.body?.data || ![0, 200].includes(result.body.code)) {
        throw fail('WEB_RESPONSE_CHANGED', '网页接口响应不符合预期，请重新登录或检查插件更新');
      }
      return result.body.data;
    } catch (error) {
      if (signal?.aborted) {
        throw fail('CANCELLED', '查询已取消');
      }
      if (error.code === 'TIMEOUT') {
        abort();
      }
      if (['CANCELLED', 'TIMEOUT', 'LOGIN_REQUIRED', 'FORBIDDEN', 'RATE_LIMITED', 'WEB_REQUEST_FAILED', 'WEB_RESPONSE_CHANGED'].includes(error.code)) {
        throw error;
      }
      throw fail('WEB_REQUEST_FAILED', '网页登录窗口不可用，请重新打开登录');
    } finally {
      signal?.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', abort);
    }
  }

  async check() {
    if (this.opening) {
      await this.opening;
    }
    if (this.closing) {
      return this.status();
    }
    const page = this.page;
    const lifetime = this.lifetime;
    try {
      const account = await this.read(this.site, '/api/typhon/account/me');
      if (this.page !== page || this.lifetime !== lifetime || this.closing) {
        return this.status();
      }
      if (!account.me) {
        this.invalidate(page, lifetime);
        return this.status();
      }
      const accountId = account.me.uid || account.me.id || account.me._id;
      if (this.state !== 'connected' || !accountId || accountId !== this.accountId) {
        this.rotate();
      }
      this.accountId = accountId;
      this.state = 'connected';
      this.error = null;
    } catch (error) {
      if (this.page !== page || this.lifetime !== lifetime || this.closing) {
        return this.status();
      }
      if (error.code === 'LOGIN_REQUIRED') {
        this.invalidate(page, lifetime);
        return this.status();
      }
      this.state = error.code === 'LOGIN_REQUIRED' ? 'needs-login' : 'error';
      this.error = error.message;
    }
    return this.status();
  }

  async shutdown() {
    const browser = this.browser;
    const process = this.process;
    this.browser = null;
    this.process = null;
    this.page = null;
    this.context = null;
    this.lifetime.abort();
    if (browser) {
      if (browser.newBrowserCDPSession) {
        await bounded((async () => {
          const protocol = await browser.newBrowserCDPSession();
          await protocol.send('Browser.close');
        })(), 2000).catch(() => {});
      }
      if (process?.done) {
        await bounded(process.done, 2000).catch(() => {});
      }
      await bounded(browser.close(), 2000).catch(() => {});
    }
    if (process) {
      await process.close();
    }
  }

  close({ logout = false } = {}) {
    if (this.closing) {
      this.clearOnClose ||= logout;
      return this.closing;
    }
    this.clearOnClose = logout;
    this.state = 'closing';
    this.rotate();
    this.closing = (async () => {
      if (this.opening) { await this.opening; }
      const profile = this.profile;
      await this.shutdown();
      if (this.clearOnClose && profile) { await rm(profile, { recursive: true, force: true }); }
      this.state = 'closed';
      this.rotate();
    })().finally(() => { this.closing = null; this.clearOnClose = false; });
    return this.closing;
  }
}
