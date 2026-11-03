import { createServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import { readFile, lstat } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);
export const cacheableResource = path => ['.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp',
  '.gif', '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.wasm'].includes(extname(path));

export function httpError(status, message) {
  return Object.assign(Error(message), { status });
}

export async function body(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw httpError(413, '请求过大');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw httpError(415, '仅接受 JSON 请求');
  }
  try {
    return JSON.parse((await body(request)).toString());
  } catch (error) {
    if (error.status) {
      throw error;
    }
    throw httpError(400, 'JSON 请求无效');
  }
}

export function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.json': 'application/json' };

// Explicit refusal wins over a wildcard; dynamic responses never enter this compression path.
function acceptsGzip(header = '') {
  const preferences = header.split(',').map(value => {
    const [name, ...parameters] = value.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    return { name: name.trim(), quality: quality === undefined ? 1 : Number(quality.trim().slice(2)) };
  });
  const preference = preferences.find(value => value.name === 'gzip') || preferences.find(value => value.name === '*');
  return preference?.quality > 0 && preference.quality <= 1;
}

// Every component is checked: lexical containment alone does not stop symlinks escaping the package.
export async function staticFile(response, directory, pathname, { cache = false, validate = () => {}, transform = value => value } = {}) {
  let path;
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes('\0') || decoded.includes('\\')) {
      throw Error('Invalid path');
    }
    path = resolve(directory, `.${decoded}`);
    const within = relative(directory, path);
    if (!within || within.startsWith('..') || isAbsolute(within)) {
      throw Error('Outside resource root');
    }
    let part = directory;
    for (const name of within.split('/')) {
      part = resolve(part, name);
      if ((await lstat(part)).isSymbolicLink()) {
        throw Error('Resource symlink');
      }
    }
    if (!(await lstat(path)).isFile()) {
      throw Error('Not a file');
    }
  } catch {
    throw httpError(404, '资源不存在');
  }
  const data = await transform(await readFile(path), extname(path));
  let payload = data;
  const headers = { 'content-type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8` };
  if (['.html', '.js', '.css', '.svg'].includes(extname(path))) {
    headers.vary = 'Accept-Encoding';
    if (data.length >= 1024 && acceptsGzip(response.req.headers['accept-encoding'])) {
      try {
        const compressed = await compress(data);
        if (compressed.length < data.length) {
          payload = compressed;
          headers['content-encoding'] = 'gzip';
        }
      } catch (error) {
        payload = data;
        console.error('[web:static-compression]', { path: pathname, stack: error.stack });
      }
    }
  }
  // Revocation during disk reads or compression must win before any cacheable bytes are published.
  validate();
  response.writeHead(200, { ...headers, 'content-length': payload.length,
    'cache-control': cache && cacheableResource(path) ? 'private, max-age=604800, immutable' : 'no-store' });
  response.end(payload);
}

export async function listener(tls, handle, port) {
  const sockets = new Set();
  // Remote services share TLS connections without changing LAN negotiation or the grant's socket boundary.
  const create = port === null ? createSecureServer : createServer;
  const options = port === null ? { allowHTTP1: true, maxSessionMemory: 8, maxHeaderListPairs: 64,
    settings: { maxConcurrentStreams: 32, maxHeaderListSize: 16384, enablePush: false } } : {};
  const server = create({ ...tls, ...options, maxHeaderSize: 16384, requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'strict-origin');
    Promise.resolve().then(() => handle(request, response)).catch(error => {
      const status = error.status || { INVALID_ARGUMENT: 400, FILE_NOT_FOUND: 404 }[error.code] || 500;
      if (status >= 500) {
        console.error('[web:request]', { path: request.url?.split('?')[0], stack: error.stack });
      }
      if (response.headersSent) {
        response.destroy();
      } else {
        json(response, { error: { code: 'WEB_ERROR', message: status < 500 ? error.message : '网页服务请求失败' } }, status);
      }
    });
  });
  // Relay latency can exceed HTTP's idle deadline; remote sockets already belong to a capped, revocable transport grant.
  if (port === null) {
    server.keepAliveTimeout = 0;
    server.on('sessionError', error => console.error('[web:http2-session]', { stack: error.stack }));
  }
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.maxConnections = 128;
  if (port !== null) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }
  // Keep late listener errors away from Electron's main process exception path.
  server.on('error', error => console.error('[web:listener]', { port: server.address()?.port, stack: error.stack }));
  return { port: server.address()?.port, accept: socket => server.emit('connection', socket), close: () => new Promise(resolve => {
    if (server.listening) { server.close(resolve); } else { resolve(); }
    for (const socket of sockets) {
      socket.destroy();
    }
  }) };
}
