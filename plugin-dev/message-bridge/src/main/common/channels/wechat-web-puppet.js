import { setTimeout as delay } from 'node:timers/promises';
import { PuppetWechat4u } from 'wechaty-puppet-wechat4u';
import { AlreadyLogoutError } from 'wechat4u/lib/core.js';
import { loginWebClient } from './wechat-web-login.js';

export class WechatWebPuppet extends PuppetWechat4u {
  connectionAbort = new AbortController();

  constructor({ report } = {}) {
    super();
    this.report = report;
  }

  async onStart() {
    this.connectionAbort = new AbortController();
    this.reconnectTask = undefined;
    await super.onStart();
  }

  monkeyPatch(client) {
    super.monkeyPatch(client);
    const request = client.request;
    const { signal } = this.connectionAbort;
    // Web login long-polls must end with this connection rather than keeping the worker alive.
    client.request = options => request({ ...options, signal });
    const login = client.login;
    client.login = () => signal.aborted ? Promise.resolve() : loginWebClient(client, login);
    const checkLogin = client.checkLogin.bind(client);
    client.checkLogin = async () => {
      const result = await checkLogin();
      if (!signal.aborted && [201, 200].includes(result.code)) {
        this.emit('scan', { qrcode: this.scanQrCode || '', status: result.code === 201 ? 3 : 4 });
      }
      return result;
    };
    const start = client.start.bind(client);
    client.start = () => signal.aborted ? Promise.resolve() : start();
    // Upstream reconnect has an anonymous 60-second timer that stop() cannot cancel.
    client.restart = () => this.reconnect(client, signal);
  }

  reconnect(client, signal) {
    if (signal.aborted) {
      return Promise.resolve();
    }
    // Heartbeat and sync polling can both request recovery; one connection must initialize only once.
    if (this.reconnectTask) {
      return this.reconnectTask;
    }
    const task = this.reconnectClient(client, signal).finally(() => {
      if (this.reconnectTask === task) {
        this.reconnectTask = undefined;
      }
    });
    this.reconnectTask = task;
    return task;
  }

  async reconnectClient(client, signal) {
    if (signal.aborted) {
      return;
    }
    try {
      // Full SDK initialization emits login again, so release only the identity and retain reusable credentials.
      if (this.isLoggedIn) {
        await this.logout();
      }
      if (signal.aborted) {
        return;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await client._init();
          return;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          if (error instanceof AlreadyLogoutError) {
            await this.restartLogin(client, signal);
            return;
          }
          if (error.response || attempt === 1) {
            throw error;
          }
          client.emit('error', error);
          await delay(60000, undefined, { signal });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        client.emit('error', error);
        client.stop();
      }
    }
  }

  initHookEvents(client) {
    super.initHookEvents(client);
    const { signal } = this.connectionAbort;
    client.removeAllListeners('logout');
    client.on('logout', () => this.handleLogout(client, signal));
  }

  async handleLogout(client, signal) {
    try {
      // A failed login must stay visible; upstream stop() emits logout even before authentication succeeds.
      if (signal.aborted || !this.isLoggedIn) {
        return;
      }
      await this.restartLogin(client, signal);
    } catch (error) {
      this.report?.('wechat-web-logout', error);
    }
  }

  async restartLogin(client, signal) {
    // Expired restored sessions need a fresh QR code; a failed first login must keep its error instead.
    if (signal.aborted) {
      return;
    }
    if (this.isLoggedIn) {
      await this.logout();
    }
    if (signal.aborted) {
      return;
    }
    await this.memory.delete('PUPPET-WECHAT4U');
    if (signal.aborted) {
      return;
    }
    await this.memory.save();
    if (!signal.aborted) {
      client.start();
    }
  }

  async onStop() {
    const client = this.wechat4u;
    // Upstream treats logout as reconnect, even during stop; detach before aborting or emitting logout.
    if (client) {
      client.removeAllListeners();
      client.on('error', error => {
        if (error.code !== 'ERR_CANCELED') {
          this.report?.('wechat-web-stopping', error);
        }
      });
    }
    this.connectionAbort.abort();
    clearInterval(this.getContactInterval);
    this.getContactInterval = undefined;
    if (client) {
      await super.onStop();
    }
  }

  async waitStable() {
    const { signal } = this.connectionAbort;
    let maximum = 0;
    let unchanged = 0;
    // The upstream contact-stability loop has no cancellation and otherwise survives plugin shutdown.
    while (!signal.aborted && unchanged < 5) {
      try {
        await delay(4000, undefined, { signal });
      } catch (error) {
        if (error.name === 'AbortError') {
          return;
        }
        throw error;
      }
      const count = (await this.contactList()).length;
      unchanged = count > 0 && count === maximum ? unchanged + 1 : 0;
      maximum = Math.max(maximum, count);
    }
    if (!signal.aborted) {
      this.emit('ready', { data: 'stable' });
    }
  }
}
