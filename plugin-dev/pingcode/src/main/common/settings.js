import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from './client.js';

const defaults = {
  apiRoot: 'https://open.pingcode.com', site: 'https://qxsh20230413015201829.pingcode.com',
  authMode: 'web', webMode: 'extension', clientId: '', accessToken: '', clientSecret: '', valueKey: 'renwujiazhifen',
  projectId: '64fc8d0c8198e2525bef8537', revision: ''
};
const fields = ['apiRoot', 'site', 'authMode', 'webMode', 'clientId', 'valueKey', 'projectId'];

export class SettingsStore {
  constructor(root) {
    this.root = root;
    this.pending = Promise.resolve();
  }

  async snapshot() {
    await this.pending;
    try {
      return { ...defaults, ...JSON.parse(await readFile(join(this.root, 'connection.json'), 'utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ...defaults };
      }
      throw Error('无法读取 PingCode 配置，请检查插件数据文件');
    }
  }

  async read() {
    const { accessToken, clientSecret, ...visible } = await this.snapshot();
    return { ...visible, hasAccessToken: Boolean(accessToken), hasClientSecret: Boolean(clientSecret) };
  }

  save(change) {
    const before = this.pending;
    const operation = before.then(async () => {
      let current;
      try {
        current = { ...defaults, ...JSON.parse(await readFile(join(this.root, 'connection.json'), 'utf8')) };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw Error('无法读取 PingCode 配置，请检查插件数据文件');
        }
        current = { ...defaults };
      }
      const next = { ...current };
      for (const field of fields) {
        if (Object.hasOwn(change, field)) {
          if (typeof change[field] !== 'string') {
            throw Error('连接配置字段必须为文本');
          }
          next[field] = change[field].trim();
        }
      }
      next.apiRoot = next.apiRoot.replace(/\/+$/, '');
      next.site = next.site.replace(/\/+$/, '');
      validateConfig(next);
      if (!['extension', 'window'].includes(next.webMode)) {
        throw Error('网页登录方式无效');
      }
      if (next.authMode === 'web' && next.webMode === 'extension' && !new URL(next.site).hostname.endsWith('.pingcode.com')) {
        throw Error('浏览器扩展目前仅支持 PingCode 公有云站点；私有部署请选择独立登录窗口');
      }
      // A different API destination must not receive a previously stored credential by accident.
      if (next.apiRoot !== current.apiRoot) {
        next.accessToken = '';
        next.clientSecret = '';
      }
      for (const [field, clear] of [['accessToken', 'clearAccessToken'], ['clientSecret', 'clearClientSecret']]) {
        if (change[clear] === true) {
          next[field] = '';
        } else if (typeof change[field] === 'string' && change[field].trim()) {
          next[field] = change[field].trim();
        }
      }
      next.revision = randomUUID();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const target = join(this.root, 'connection.json');
      const temporary = join(this.root, `connection-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.pending = operation.catch(() => {});
    return operation.then(() => this.read());
  }
}
