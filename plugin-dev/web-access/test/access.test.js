import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { WebWorkspace } from '../../../web/src/server/workspace.js';
import * as engine from '../node_modules/@number0/iroh/index.js';
import { AccessService } from '../src/main/common/access.js';
import { ALPN, readFrame, writeFrame, within } from '../src/main/common/protocol.js';

// Fixtures stay offline while checking the approved fallback relay configuration.
test('two iroh endpoints pair only after native confirmation and carry only Web TLS', { timeout: 45000 }, async t=>{
  const root=await mkdtemp(join(tmpdir(),'wd-iroh-'));
  const storage=new Storage(root);
  const web=new WebWorkspace({root,storage,plugins:{list:()=>[],assertEnabled:()=>{}},handlers:{}});
  const owner={id:'web-access',instanceId:'test'};
  let relayConfigured = false;
  const native={...engine,RelayMode:{customFromUrls:urls=>{
    assert.deepEqual(urls, ['https://usw1-1.relay.n0.iroh.link./']);
    relayConfigured = true;
    return engine.RelayMode.customFromUrls(urls);
  }},Endpoint:{bind:async (opts, relayMode)=>{
    assert.equal(relayConfigured, true, 'host must explicitly select the approved fallback relay');
    const builder=engine.Endpoint.builder();builder.applyMinimal();builder.bindAddr('127.0.0.1:0');
    builder.secretKey(opts.secretKey);builder.alpns(opts.alpns);return builder.bind();
  }}};
  const service=new AccessService({context:{pluginId:'web-access',storage,host:{transport:{
    describe:()=>web.transport.describe(),open:input=>web.transport.open(owner,input),revoke:id=>web.transport.revoke(owner,id)
  }}},platform:{loadEngine:async()=>native}});
  let client;
  t.after(async()=>{
    await service.stop();
    await client?.close();
    await web.close();
    await Promise.all([...storage.pending.values()]);
    await rm(root,{recursive:true,force:true});
  });
  await web.saveAccount('tester','testing-password');
  await web.configure({enabled:true,port:0});
  assert.equal(service.status().running,false);
  await service.start();
  const invite=service.createInvitation();
  const b=engine.Endpoint.builder();b.applyMinimal();b.bindAddr('127.0.0.1:0');
  client=await b.bind();
  const address=engine.EndpointTicket.fromString(invite.ticket).endpointAddr();
  assert.equal(address.relayUrl(), null);
  const host=address;
  const pair=await within(client.connect(host,[...Buffer.from(ALPN)]),10000);
  assert.ok(pair.paths().some(path => path.isIp && path.isSelected));
  assert.ok(pair.paths().every(path => !path.isRelay));
  const control=await pair.openBi();
  await writeFrame(control.send,{type:'hello',version:1});
  const challenge=await readFrame(control.recv);
  const deviceId=client.id().toString();
  const proof=createHmac('sha256',Buffer.from(invite.secret,'hex'))
    .update(`${ALPN}\n${invite.hostId}\n${deviceId}\n${invite.pairId}\n${challenge.nonce}`).digest('hex');
  await writeFrame(control.send,{type:'pair',pairId:invite.pairId,label:'Test phone',proof});
  const pending=await readFrame(control.recv);
  assert.equal(pending.type,'pending');
  assert.equal(service.status().devices.length,0);
  await service.confirm(pending.requestId);
  assert.equal((await readFrame(control.recv)).type,'paired');
  pair.close(0n,[]);
  const connection=await client.connect(host,[...Buffer.from(ALPN)]);
  const handshake=await connection.openBi();
  await writeFrame(handshake.send,{type:'hello',version:1});
  await readFrame(handshake.recv);
  await writeFrame(handshake.send,{type:'connect',origins:{workspace:'https://127.0.0.1:49111'}});
  const ready=await readFrame(handshake.recv);
  assert.equal(ready.type,'ready');
  assert.match(ready.certificateHash,/^[a-f0-9]{64}$/);
  const stream=await connection.openBi();
  await writeFrame(stream.send,{type:'stream',serviceId:'workspace'});
  const duplex=new Duplex({read(){stream.recv.read(65536).then(bytes=>this.push(bytes.length?Buffer.from(bytes):null),e=>this.destroy(e));},
    write(chunk,encoding,cb){stream.send.writeAll([...chunk]).then(()=>cb(),cb);},
    final(cb){stream.send.finish().then(()=>cb(),cb);}});
  const secure=tls.connect({socket:duplex,rejectUnauthorized:false});
  await within(once(secure,'secureConnect'),5000);
  secure.write('GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:49111\r\nConnection: close\r\n\r\n');
  const parts=[];
  for await(const part of secure){parts.push(part);}
  const response = Buffer.concat(parts).toString();
  assert.match(response, /^HTTP\/1.1 200/);
  assert.match(response, /set-cookie: __Host-deckpg=/i);
  await stream.send.reset(0n);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(connection.closeReason(), null, 'closing one HTTP stream must preserve the device connection');
  assert.equal(web.transport.grants.size, 1);

  // Stream isolation must not turn malformed targets or quota failures into recoverable requests.
  const invalid = await connection.openBi();
  await writeFrame(invalid.send, { type: 'stream', serviceId: 'workspace', port: 22 });
  await within(connection.closed(), 3000);
  const reconnect = async () => {
    const peer = await client.connect(host, [...Buffer.from(ALPN)]);
    const control = await peer.openBi();
    await writeFrame(control.send, { type: 'hello', version: 1 });
    await readFrame(control.recv);
    await writeFrame(control.send, { type: 'connect', origins: { workspace: 'https://127.0.0.1:49111' } });
    assert.equal((await readFrame(control.recv)).type, 'ready');
    return peer;
  };
  const limited = await reconnect();
  const overBudget = await limited.openBi();
  await writeFrame(overBudget.send, { type: 'stream', serviceId: 'workspace' });
  service.totalTraffic = { at: Date.now(), size: 10 * 1024 * 1024 };
  await overBudget.send.writeAll([1]);
  await within(limited.closed(), 3000);
  const revocable = await reconnect();
  await service.revoke(deviceId);
  assert.equal(service.status().devices.length,0);
  await within(revocable.closed(),3000);
  assert.equal(web.transport.grants.size,0);
});

test('stop closes endpoint even when Web grant revocation fails', async () => {
  let closed = false;
  const service = new AccessService({ context: { pluginId: 'web-access', storage: { writeJson: async () => {} }, host: { transport: {
    revoke: async () => { throw Error('Web unavailable'); }
  } } }, platform: {} });
  service.endpoint = { close: async () => { closed = true; } };
  service.connections.set('one', { connectionId: 'one', sockets: new Set(), grant: { grantId: 'grant' } });
  await assert.rejects(service.stop(), /Web unavailable/);
  assert.equal(closed, true);
});

test('an older stop cannot close an endpoint created while grant revocation waits', async () => {
  let release;
  const revoking = new Promise(resolve => { release = resolve; });
  const closed = [];
  const service = new AccessService({ context: { pluginId: 'web-access', storage: { writeJson: async () => {} }, host: { transport: {
    revoke: () => revoking
  } } }, platform: {} });
  service.endpoint = { close: async () => { closed.push('old'); } };
  service.connections.set('one', { connectionId: 'one', sockets: new Set(), grant: { grantId: 'grant' } });
  const stopping = service.stop();
  service.endpoint = { close: async () => { closed.push('new'); } };
  service.running = true;
  release();
  await stopping;
  assert.deepEqual(closed, ['old']);
  assert.equal(service.running, true);
  assert.ok(service.endpoint);
});

test('traffic is capped for both one device and the whole running instance', () => {
  const service = new AccessService({ context: {}, platform: {} });
  service.consume('one', 8 * 1024 * 1024);
  assert.throws(() => service.consume('one', 3 * 1024 * 1024), /设备流量/);
  const total = new AccessService({ context: {}, platform: {} });
  total.consume('one', 6 * 1024 * 1024);
  total.consume('two', 4 * 1024 * 1024);
  assert.throws(() => total.consume('fifth', 1), /总流量/);
});

test('connection diagnostics retain only bounded metadata and cannot fail the connection', async () => {
  let journal;
  const service = new AccessService({ context: { pluginId: 'web-access', storage: {
    writeJson: async (key, value) => { journal = { key, value }; }
  } }, platform: {} });
  const state = { connectionId: 'connection', deviceId: 'device', connection: {
    stats: () => ({ udpTxBytes: 42, udpRxBytes: 84, lostPackets: 1, secret: 'not-logged' }),
    paths: () => [{ isSelected: true, isRelay: true, rttMs: 123, remoteAddr: 'not-logged' }]
  } };
  for (let index = 0; index < 130; index++) { await service.diagnose(state, `stage-${index}`); }
  assert.equal(journal.key, 'plugin-data/web-access/connection-diagnostics.json');
  assert.equal(journal.value.length, 128);
  assert.equal(journal.value[0].stage, 'stage-2');
  assert.equal(journal.value.at(-1).rx, 84);
  assert.equal(journal.value.at(-1).path, 'relay');
  assert.ok(!JSON.stringify(journal).includes('not-logged'));
  service.context.storage.writeJson = async () => { throw Error('diagnostic disk unavailable'); };
  await assert.doesNotReject(service.diagnose(state, 'grant-issued'));
});
