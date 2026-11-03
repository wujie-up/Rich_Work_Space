import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import { webkit } from 'playwright';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../desk/src/main/common/storage.js';
import { WebWorkspace } from '../src/server/workspace.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'wd-transport-'));
  const storage = new Storage(join(root,'data'));
  await mkdir(join(root,'web/dist'),{recursive:true});
  for (const name of ['plugin-input.js', 'plugin-input.css', 'plugin-input-manifest.json']) {
    await cp(join('web/dist', name), join(root, 'web/dist', name));
  }
  await writeFile(join(root,'web/dist/index.html'),'workspace');
  const plugin = await storage.path('plugins/example');
  await mkdir(plugin,{recursive:true});
  await writeFile(join(plugin,'index.html'),'plugin');
  const plugins = {list:()=>[{id:'example',state:'enabled'}],assertEnabled:id=>assert.equal(id,'example')};
  const web = new WebWorkspace({root,storage,plugins,handlers:{'plugins.list':plugins.list}});
  t.after(async()=>{await web.close();await rm(root,{recursive:true,force:true});});
  await web.saveAccount('tester','testing-password');
  await web.configure({enabled:true,port:0});
  return web;
}

export async function tunnel(grant, serviceId, path, {body,cookie,origin,host,csrf}={}) {
  const socket = net.connect(grant.path);
  await once(socket,'connect');
  socket.write(JSON.stringify({capability:grant.capability,serviceId})+'\n');
  assert.equal((await once(socket,'data'))[0].toString(), 'OK\n');
  const secure=tls.connect({socket,rejectUnauthorized:false});
  secure.setTimeout(5000,()=>secure.destroy(Error('TLS tunnel timeout')));
  await once(secure,'secureConnect');
  const mapped=grant.origins[serviceId];
  const data=body && JSON.stringify(body);
  secure.write(`${body?'POST':'GET'} ${path} HTTP/1.1\r\nHost: ${host||new URL(mapped).host}\r\nConnection: close\r\nOrigin: ${origin||mapped}\r\n${cookie?`Cookie: ${cookie}\r\n`:''}${csrf?`X-Deckpg-Csrf: ${csrf}\r\n`:''}${data?`Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n`:''}\r\n${data||''}`);
  const chunks=[];
  for await(const chunk of secure){chunks.push(chunk);}
  const text=Buffer.concat(chunks).toString();
  const [headers,...parts]=text.split('\r\n\r\n');
  const payload=parts.join('\r\n\r\n');
  const decoded=/transfer-encoding: chunked/i.test(headers) ? payload.split('\r\n').filter((_,i)=>i%2===1).join('') : payload;
  return {status:Number(headers.split(' ')[1]),headers,text:decoded};
}

test('Web receives only declared services and isolates transport A/B/LAN sessions',async t=>{
  const web=await setup(t);
  const owner={id:'transport',instanceId:'runtime-a'};
  const origins={workspace:'https://127.0.0.1:49101','plugin:example':'https://127.0.0.1:49102'};
  assert.ok(web.transport,'Web-owned transport registry is required');
  for(const value of [
    {deviceId:'a',origins,target:'127.0.0.1:22'},
    {deviceId:'a',origins:{workspace:'https://evil.example:49101'}},
    {deviceId:'a',origins:{...origins,'plugin:missing':'https://127.0.0.1:49103'}},
    {deviceId:'a',origins:{workspace:origins.workspace,'plugin:example':origins.workspace}}
  ]) {await assert.rejects(web.transport.open(owner,value));}
  const a=await web.transport.open(owner,{deviceId:'device-a',origins});
  const b=await web.transport.open(owner,{deviceId:'device-b',origins:{workspace:'https://127.0.0.1:49201','plugin:example':'https://127.0.0.1:49202'}});
  assert.equal((await tunnel(a,'workspace','/api/session')).status,200);
  assert.equal((await tunnel(a,'workspace','/',{host:'127.0.0.1:22'})).status,403);
  assert.equal((await tunnel(a,'workspace','/api/login',{body:{username:'tester',password:'testing-password'},origin:'https://evil.example'})).status,403);
  const login=await tunnel(a,'workspace','/api/login',{body:{username:'tester',password:'testing-password'}});
  assert.equal(login.status,200);
  const cookie=login.headers.match(/set-cookie: ([^;]+)/i)[1];
  const csrf=JSON.parse(login.text).csrf;
  assert.equal((await tunnel(a,'workspace','/api/session',{cookie})).status,200);
  assert.equal((await tunnel(b,'workspace','/api/session',{cookie})).status,401);
  assert.throws(()=>web.authenticate({headers:{cookie}}),{status:401});
  assert.equal((await tunnel(a,'plugin:example','/index.html',{cookie})).status,200);
  const listed=await tunnel(a,'workspace','/api/rpc',{cookie,csrf,body:{method:'plugins.list',args:[]}});
  assert.equal(JSON.parse(listed.text).value[0].webPort,49102);
  await web.transport.revoke(owner,a.grantId);
  assert.throws(()=>web.authenticate({headers:{cookie}}),{status:401});
  assert.equal((await tunnel(b,'workspace','/api/session',{cookie})).status,401);
  await assert.rejects(tunnel(a,'workspace','/api/session',{cookie}));
  await web.transport.closeOwner({id:'transport',instanceId:'stale'});
  assert.equal((await tunnel(b,'workspace','/')).status,200);
  await web.transport.closeOwner(owner);
  await assert.rejects(tunnel(b,'workspace','/'));
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function multiplexedTunnel(t, grant, serviceId = 'workspace') {
  const socket = net.connect(grant.path);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(JSON.stringify({ capability: grant.capability, serviceId }) + '\n');
  assert.equal((await once(socket, 'data'))[0].toString(), 'OK\n');
  const secure = tls.connect({ socket, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
  t.after(() => secure.destroy());
  await once(secure, 'secureConnect');
  assert.equal(secure.alpnProtocol, 'h2', 'remote receiver must negotiate multiplexing');
  const client = http2.connect(grant.origins[serviceId], { createConnection: () => secure });
  t.after(() => client.destroy());
  await once(client, 'connect');
  return client;
}

async function multiplexedRequest(client, path, { body, ...headers } = {}) {
  const stream = client.request({ ':path': path, ':method': body ? 'POST' : 'GET',
    ...(body ? { 'content-type': 'application/json' } : {}), ...headers });
  const response = new Promise((resolve, reject) => {
    stream.once('response', resolve);
    stream.once('error', reject);
    stream.once('close', () => reject(Error('Stream closed before response')));
  });
  stream.end(body ? JSON.stringify(body) : undefined);
  const content = (async () => {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  })();
  const [received, text] = await Promise.all([response, content]);
  return { headers: received, text };
}

test('remote HTTP/2 multiplexes authorized requests and preserves authority, Origin and CSRF checks', async t => {
  const web = await setup(t);
  const owner = { id: 'transport' };
  const origins = { workspace: 'https://127.0.0.1:49101', 'plugin:example': 'https://127.0.0.1:49102' };
  const grant = await web.transport.open(owner, { deviceId: 'phone', origins });
  const client = await multiplexedTunnel(t, grant);
  const initial = await multiplexedRequest(client, '/api/session');
  assert.equal(initial.headers[':status'], 200);
  const cookie = initial.headers['set-cookie'][0].split(';')[0];
  const csrf = JSON.parse(initial.text).csrf;
  const rpc = { cookie, origin: origins.workspace, 'x-deckpg-csrf': csrf, body: { method: 'plugins.list', args: [] } };
  const entered = deferred();
  const release = deferred();
  let count = 0;
  web.handlers['plugins.list'] = async () => {
    if (++count === 6) {
      entered.resolve();
    }
    await release.promise;
    return [];
  };
  const concurrent = Promise.all(Array.from({ length: 6 }, () => multiplexedRequest(client, '/api/rpc', rpc)));
  await entered.promise;
  release.resolve();
  assert.ok((await concurrent).every(value => value.headers[':status'] === 200));
  assert.equal(web.transport.grants.get(grant.grantId).sockets.size, 1, 'six concurrent requests share one admitted socket');
  for (const headers of [{ ':authority': '127.0.0.1:22' }, { host: '127.0.0.1:22' }]) {
    assert.equal((await multiplexedRequest(client, '/api/session', headers)).headers[':status'], 403);
  }
  assert.equal((await multiplexedRequest(client, '/api/rpc', { ...rpc, origin: 'https://evil.example' })).headers[':status'], 403);
  assert.equal((await multiplexedRequest(client, '/api/rpc', { ...rpc, 'x-deckpg-csrf': 'wrong' })).headers[':status'], 403);
  const plugin = await multiplexedTunnel(t, grant, 'plugin:example');
  assert.match((await multiplexedRequest(plugin, '/index.html', { cookie })).text, /plugin$/);
  assert.equal((await multiplexedRequest(plugin, '/api/session', { cookie })).headers[':status'], 404);
  const other = await web.transport.open(owner, { deviceId: 'other-phone', origins });
  const otherClient = await multiplexedTunnel(t, other);
  assert.equal((await multiplexedRequest(otherClient, '/api/session', { cookie })).headers[':status'], 401);
  const closed = once(client, 'close');
  await web.transport.revoke(owner, grant.grantId);
  await closed;
  assert.equal((await multiplexedRequest(otherClient, '/api/session')).headers[':status'], 200);
});

test('HTTP/2 events stay subscribed during RPC and revocation terminates events and in-flight work', async t => {
  const web = await setup(t);
  const owner = { id: 'transport' };
  const origins = { workspace: 'https://127.0.0.1:49101' };
  const grant = await web.transport.open(owner, { deviceId: 'phone', origins });
  const client = await multiplexedTunnel(t, grant);
  const initial = await multiplexedRequest(client, '/api/session');
  const cookie = initial.headers['set-cookie'][0].split(';')[0];
  const csrf = JSON.parse(initial.text).csrf;
  const events = client.request({ ':path': '/api/events', cookie });
  events.end();
  assert.equal((await once(events, 'response'))[0][':status'], 200);
  await once(events, 'data');
  assert.equal(web.clients.size, 1);
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  web.handlers['plugins.list'] = async () => {
    entered.resolve();
    await release.promise;
    completed.resolve();
    return [];
  };
  const pending = multiplexedRequest(client, '/api/rpc', { cookie, origin: origins.workspace,
    'x-deckpg-csrf': csrf, body: { method: 'plugins.list', args: [] } }).then(value => value, error => error);
  await entered.promise;
  const changed = once(events, 'data');
  web.emit('test:update', { ok: true });
  assert.match((await changed)[0].toString(), /test:update/);
  const closed = once(client, 'close');
  await web.transport.revoke(owner, grant.grantId);
  release.resolve();
  await completed.promise;
  await closed;
  const result = await pending;
  assert.ok(result instanceof Error || result.headers[':status'] !== 200);
  assert.equal(web.clients.size, 0);
});

test('mobile WebKit reuses HTTP/2 through the unchanged opaque TCP transport', { timeout: 15000 }, async t => {
  const web = await setup(t);
  let grant;
  const sockets = new Set();
  const ingress = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const upstream = net.connect(grant.path);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('connect', () => upstream.write(JSON.stringify({ capability: grant.capability, serviceId: 'workspace' }) + '\n'));
    upstream.once('data', data => {
      assert.equal(data.toString(), 'OK\n');
      socket.pipe(upstream).pipe(socket);
    });
  });
  await new Promise(resolve => ingress.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise(resolve => ingress.close(resolve));
  });
  const origin = `https://127.0.0.1:${ingress.address().port}`;
  grant = await web.transport.open({ id: 'transport' }, { deviceId: 'phone', origins: { workspace: origin } });
  const versions = [];
  const handle = web.handle.bind(web);
  web.handle = (request, response) => {
    versions.push(request.httpVersionMajor);
    return handle(request, response);
  };
  const browser = await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ignoreHTTPSErrors: true, isMobile: true, viewport: { width: 393, height: 852 } });
  await page.goto(origin);
  const results = await page.evaluate(async () => {
    const { csrf } = await (await fetch('/api/session')).json();
    return Promise.all(Array.from({ length: 6 }, async () => {
      const response = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json',
        'x-deckpg-csrf': csrf }, body: JSON.stringify({ method: 'plugins.list', args: [] }) });
      return (await response.json()).ok;
    }));
  });
  assert.deepEqual(results, Array(6).fill(true));
  assert.ok(versions.length >= 8 && versions.every(version => version === 2));
  assert.equal(web.transport.grants.get(grant.grantId).sockets.size, 1);
});

test('paired transport bootstraps a connection-bound session without a Web account password', async t => {
  const web = await setup(t);
  const owner = { id: 'transport' };
  const origins = { workspace: 'https://127.0.0.1:49101', 'plugin:example': 'https://127.0.0.1:49102' };
  const a = await web.transport.open(owner, { deviceId: 'phone-a', origins });
  const b = await web.transport.open(owner, { deviceId: 'phone-b', origins });
  assert.equal((await tunnel(a, 'workspace', '/api/session', { origin: 'https://evil.example' })).status, 403);
  const initial = await tunnel(a, 'workspace', '/api/session');
  assert.equal(initial.status, 200);
  const cookie = initial.headers.match(/set-cookie: ([^;]+)/i)[1];
  assert.match(initial.headers, /HttpOnly; Secure; SameSite=Strict/i);
  const { csrf } = JSON.parse(initial.text);
  assert.ok(csrf);
  assert.equal((await tunnel(a, 'plugin:example', '/index.html', { cookie })).status, 200);
  assert.equal((await tunnel(b, 'workspace', '/api/session', { cookie })).status, 401);
  assert.throws(() => web.authenticate({ headers: { cookie } }), { status: 401 });
  assert.equal((await tunnel(a, 'workspace', '/api/rpc', { cookie, body: { method: 'plugins.list', args: [] } })).status, 403);
  assert.equal((await tunnel(a, 'workspace', '/api/rpc', { cookie, csrf, body: { method: 'plugins.list', args: [] } })).status, 200);
  await web.removeAccount('tester');
  assert.equal((await tunnel(a, 'workspace', '/api/session', { cookie })).status, 200, 'device authorization is independent of Web accounts');
  let ended;
  web.clients.add({ token: cookie.split('=')[1], response: { end: value => { ended = value; }, write: () => {} } });
  web.revalidateClients();
  assert.equal(ended, undefined);
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  web.handlers['plugins.list'] = async () => {
    entered.resolve();
    await release.promise;
    completed.resolve();
    return [];
  };
  const pending = tunnel(a, 'workspace', '/api/rpc', { cookie, csrf, body: { method: 'plugins.list', args: [] } })
    .then(value => value, error => error);
  await entered.promise;
  await web.transport.revoke(owner, a.grantId);
  release.resolve();
  await completed.promise;
  const revoked = await pending;
  assert.ok(revoked instanceof Error || revoked.status !== 200 || !revoked.text.includes('"ok":true'));
  assert.match(ended, /revoked/);
  assert.throws(() => web.authenticate({ headers: { cookie } }), { status: 401 });
  await assert.rejects(tunnel(a, 'workspace', '/api/session', { cookie }));
  assert.equal((await tunnel(b, 'workspace', '/api/session')).status, 200);
});

test('device logout and expiry require a fresh connection, and Web shutdown revokes device sessions', async t => {
  const web = await setup(t);
  const owner = { id: 'transport' };
  const input = { deviceId: 'phone', origins: { workspace: 'https://127.0.0.1:49101' } };
  const grant = await web.transport.open(owner, input);
  const initial = await tunnel(grant, 'workspace', '/api/session');
  const cookie = initial.headers.match(/set-cookie: ([^;]+)/i)[1];
  const csrf = JSON.parse(initial.text).csrf;
  const active = web.transport.grants.get(grant.grantId);
  active.deviceSession.expires = Date.now() - 1;
  assert.equal((await tunnel(grant, 'workspace', '/api/session', { cookie })).status, 401);
  active.deviceSession.expires = Date.now() + 10000;
  assert.equal((await tunnel(grant, 'workspace', '/api/logout', { cookie, csrf, body: {} })).status, 200);
  assert.equal((await tunnel(grant, 'workspace', '/api/session', { cookie })).status, 401);
  assert.equal((await tunnel(grant, 'workspace', '/api/session')).status, 403);
  const next = await web.transport.open(owner, input);
  const connected = await tunnel(next, 'workspace', '/api/session');
  assert.equal(connected.status, 200);
  const nextCookie = connected.headers.match(/set-cookie: ([^;]+)/i)[1];
  await web.stop();
  assert.equal(web.transport.sessions.size, 0);
  assert.throws(() => web.authenticate({ headers: { cookie: nextCookie } }), { status: 401 });
  await assert.rejects(tunnel(next, 'workspace', '/api/session', { cookie: nextCookie }));
});

test('broker rejects unknown services, target injection and capability forgery before TLS', async t => {
  const web = await setup(t);
  const grant = await web.transport.open({ id: 'transport' }, { deviceId: 'phone', origins: { workspace: 'https://127.0.0.1:49100' } });
  for (const input of [
    { capability: grant.capability, serviceId: '127.0.0.1:22' },
    { capability: grant.capability, serviceId: 'workspace', target: '127.0.0.1:22' },
    { capability: 'a'.repeat(64), serviceId: 'workspace' }
  ]) {
    const socket = net.connect(grant.path);
    const chunks = [];
    socket.on('data', data => chunks.push(data));
    await once(socket, 'connect');
    socket.write(`${JSON.stringify(input)}\n`);
    await once(socket, 'close');
    assert.equal(Buffer.concat(chunks).length, 0);
  }
});

test('revoke during password hashing cannot publish a remote session as a LAN session', async t => {
  const web = await setup(t);
  const owner = { id: 'transport' };
  const grant = await web.transport.open(owner, { deviceId: 'phone', origins: { workspace: 'https://127.0.0.1:49100' } });
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  const login = web.accountStore.login.bind(web.accountStore);
  let session;
  web.accountStore.login = async (...args) => {
    entered.resolve();
    await release.promise;
    session = await login(...args);
    completed.resolve();
    return session;
  };
  const settled = tunnel(grant, 'workspace', '/api/login', { body: { username: 'tester', password: 'testing-password' } })
    .then(value => value, error => error);
  await entered.promise;
  await web.transport.revoke(owner, grant.grantId);
  release.resolve();
  await completed.promise;
  await settled;
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => web.authenticate({ headers: { cookie: `__Host-deckpg=${session.token}` } }), { status: 401 });
  assert.equal(web.transport.sessions.size, 0);
});

test('Web stop rejects an in-progress grant without publishing a receiver', async t => {
  const web = await setup(t);
  const entered = deferred();
  const release = deferred();
  const describe = web.transport.describe.bind(web.transport);
  web.transport.describe = async () => { const value = await describe(); entered.resolve(); await release.promise; return value; };
  const opening = web.transport.open({ id: 'transport' }, { deviceId: 'phone', origins: { workspace: 'https://127.0.0.1:49100' } });
  await entered.promise;
  await web.stop();
  release.resolve();
  await assert.rejects(opening);
  assert.equal(web.transport.grants.size, 0);
});

test('remote shell negotiation and versioned plugin URLs preserve login and service boundaries', async t => {
  const { createHash } = await import('node:crypto');
  const { pluginResources, pluginInputResources } = await import('../src/server/static-resources.js');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const web = await setup(t);
  const files = { 'app.js': hash('code'), 'app.css': hash('style') };
  const version = hash(JSON.stringify(files));
  const html = '<html><head><link rel="stylesheet" href="app.css"></head><body><script type="module" src="app.js"></script></body></html>';
  await writeFile(join(web.root, 'web/dist/index.html'), html);
  await writeFile(join(web.root, 'web/dist/shell-manifest.json'), JSON.stringify({ version, files }));
  const directory = await web.storage.packageDirectory('example');
  await writeFile(join(directory, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: { 'index.html': hash('plugin') } }));
  const input = await pluginInputResources(join(web.root, 'web/dist'));
  const resources = await pluginResources(directory, input.version);
  const owner = { id: 'transport', instanceId: 'versioned-test' };
  const grant = await web.transport.open(owner, { deviceId: 'phone', origins: {
    workspace: 'https://127.0.0.1:49101', 'plugin:example': 'https://127.0.0.1:49102'
  } });
  const negotiated = await tunnel(grant, 'workspace', '/?deskShell=' + version);
  assert.match(negotiated.text, /data-work-desk-shell=/);
  assert.doesNotMatch(negotiated.text, /src="app.js"|href="app.css"/);
  assert.match(negotiated.headers, /cache-control: no-store/i);
  assert.equal((await tunnel(grant, 'workspace', '/?deskShell=' + 'a'.repeat(64))).text, html);
  const path = '/' + resources.entry('index.html');
  const denied = await tunnel(grant, 'plugin:example', path);
  assert.equal(denied.status, 401);
  assert.match(denied.headers, /cache-control: no-store/i);
  const login = await tunnel(grant, 'workspace', '/api/login', { body: { username: 'tester', password: 'testing-password' } });
  const cookie = login.headers.match(/set-cookie: ([^;]+)/i)[1];
  const resource = await tunnel(grant, 'plugin:example', path, { cookie });
  assert.match(resource.text, /plugin$/);
  assert.match(resource.text, /\/_web_input\/[a-f0-9]{64}\/plugin-input.js/);
  assert.match(resource.headers, /cache-control: private, max-age=/i);
  assert.equal((await tunnel(grant, 'workspace', path, { cookie })).status, 404);
  const forged = await tunnel(grant, 'plugin:example', path.replace(resources.version, '0'.repeat(64)), { cookie });
  assert.equal(forged.status, 404);
  assert.match(forged.headers, /cache-control: no-store/i);
  await web.removeAccount('tester');
  const revoked = await tunnel(grant, 'plugin:example', path, { cookie });
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers, /cache-control: no-store/i);
});
