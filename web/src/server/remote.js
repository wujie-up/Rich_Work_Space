import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopFiles } from '../../../desk/src/main/common/desktop-files.js';
import { PluginIcons } from '../../../desk/src/main/common/plugin-icons.js';
import { body, json, httpError } from './http.js';

// Browser-selected bytes replace native pickers; a caller cannot substitute a server filesystem path.
export function createRemoteHandlers(workspace) {
  const { storage, plugins } = workspace;
  const desktop = new DesktopFiles(storage);
  const icons = new PluginIcons(storage, plugins);
  const uploads = new Map();
  const consume = async (token, session, operation) => {
    const entry = uploads.get(token);
    if (!entry || entry.session !== session.token || entry.expires < Date.now()) {
      throw httpError(400, '上传的插件包已失效，请重新选择');
    }
    return operation(entry.path);
  };
  const handlers = {
    'plugins.install': (tokens, session) => {
      if (!Array.isArray(tokens) || tokens.length > 20) {
        throw httpError(400, '请选择插件包');
      }
      return Promise.all(tokens.map(token => consume(token, session, path => plugins.install(path))));
    },
    'plugins.upgrade': (id, token, confirmation, session) => consume(token, session, path => plugins.upgrade(id, path, confirmation)),
    'plugins.setIcon': (id, token, session) => consume(token, session, path => icons.set(id, path))
  };
  async function cleanup(all = false) {
    for (const [token, entry] of uploads) {
      if (all || entry.expires < Date.now()) {
        await rm(entry.path, { force: true });
        uploads.delete(token);
      }
    }
  }
  return {
    handlers,
    invoke: (method, args, session) => {
      const arity = { 'plugins.install': 1, 'plugins.upgrade': 3, 'plugins.setIcon': 2 }[method];
      if (args.length !== arity) {
        throw httpError(400, '操作参数无效');
      }
      return handlers[method](...args, session);
    },
    clear: () => cleanup(true),
    icon: async (response, id) => {
      const path = await icons.path(id);
      const bytes = await readFile(path);
      const extension = path.split('.').pop();
      response.writeHead(200, { 'content-type': extension === 'svg' ? 'image/svg+xml' : `image/${extension === 'jpg' ? 'jpeg' : extension}` });
      response.end(bytes);
    },
    route: async (request, response, path, session) => {
      const url = new URL(request.url, 'https://localhost');
      if (path === '/api/upload' && request.method === 'POST') {
        await cleanup();
        const name = url.searchParams.get('name');
        const purpose = url.searchParams.get('purpose');
        if (typeof name !== 'string' || name.length > 200 || !name || /[/\\\x00-\x1f]/.test(name)) {
          throw httpError(400, '文件名无效');
        }
        const bytes = await body(request, 20 * 1024 * 1024);
        workspace.authenticate(request);
        if (purpose === 'desktop') {
          const value = await desktop.store(name, target => {
            workspace.authenticate(request);
            return writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
          });
          json(response, { value });
          return true;
        }
        if (!['package', 'icon'].includes(purpose) || purpose === 'package' && !name.endsWith('.plg')
          || purpose === 'icon' && !/\.(svg|png|jpe?g|webp)$/i.test(name)) {
          throw httpError(400, '上传类型无效');
        }
        if (uploads.size >= 100) {
          throw httpError(429, '暂存文件过多，请稍后重试');
        }
        const directory = await storage.path('web/uploads');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const token = randomBytes(24).toString('hex');
        const target = join(directory, `${token}.${name.split('.').pop()}`);
        workspace.authenticate(request);
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
        uploads.set(token, { session: session.token, path: target, expires: Date.now() + 15 * 60_000 });
        json(response, { value: token });
        return true;
      }
      if (path === '/api/download' && request.method === 'GET') {
        const file = await desktop.resolve(url.searchParams.get('name'));
        response.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(url.searchParams.get('name'))}` });
        await pipeline(createReadStream(file), response);
        return true;
      }
      return false;
    }
  };
}
