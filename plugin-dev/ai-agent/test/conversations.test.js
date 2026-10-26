import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversations } from '../src/main/common/conversations.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

class Engine {
  constructor(options) { Object.assign(this, options); this.calls = []; this.child = { pid: 8001 }; }
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') { return { thread: { id: 'native-thread' } }; }
    if (method === 'turn/start') { return { turn: { id: 'native-turn', status: 'inProgress' } }; }
    return {};
  }
  respond(id, result) { this.response = { id, result }; }
  close() {}
}
const runtime = { pin: { runtimeId: 'pin', version: '1' }, status: async () => ({state:'ready'}),
  launch: async () => ({ runtimeId: 'pin', runtimeVersion: '1', profileId: 'default', command: '/managed/codex', args: [], env: {} }) };
const gateway = () => ({ token: 'secret', url: 'http://127.0.0.1:123/mcp', start: async () => {}, close: async () => {},
  cancel: async () => {}, refreshCatalog: async () => false });

test('conversation persists native context and runtime pin, streams, interrupts and resumes only on explicit send', async t => {
  const storage = await temporaryStore(t);
  const events = [];
  const options = { storage, pluginId: 'ai-agent-sessions', runtime, Engine, createGateway: gateway,
    emit: (_, event) => events.push(event), ownProcesses: () => {} };
  const service = new Conversations(options);
  await service.load();
  const created = await service.create({ cwd: storage.root });
  await service.send(created.id, 'hello');
  const active = service.engines.get(created.id);
  assert.equal(active.engine.calls.at(-1).method, 'turn/start');
  active.engine.onEvent({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', delta: 'answer' } });
  await service.cancel(created.id);
  assert.equal(active.engine.calls.at(-1).method, 'turn/interrupt');
  await service.stop();
  const reopened = new Conversations(options);
  await reopened.load();
  assert.equal(reopened.engines.size, 0);
  const record = await reopened.read(created.id);
  assert.equal(record.runtimeId, 'pin');
  assert.equal(record.threadId, 'native-thread');
  assert.equal(record.state, 'interrupted');
  assert.equal(record.events.some(event => event.method === 'item/agentMessage/delta'), true);
  await reopened.send(created.id, 'resume');
  assert.equal(reopened.engines.get(created.id).engine.calls[0].method, 'thread/resume');
  await reopened.stop();
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, options = {}) {
  const storage = await temporaryStore(t);
  const service = new Conversations({ storage, pluginId: 'ai-test', runtime, Engine, createGateway: gateway,
    emit: () => {}, ownProcesses: () => {}, ...options });
  await service.load();
  t.after(() => service.stop());
  return { service, record: await service.create({ cwd: storage.root }) };
}

test('stop closes an engine during startup and prevents the pending send from starting a turn', async t => {
  const started = deferred();
  const release = deferred();
  const instances = [];
  let gatewayClosed = false;
  class SlowEngine extends Engine {
    constructor(options) { super(options); instances.push(this); }
    async start() { started.resolve(); await release.promise; }
    close() { this.closed = true; }
  }
  const { service, record } = await fixture(t, { Engine: SlowEngine,
    createGateway: () => ({ ...gateway(), close: async () => { gatewayClosed = true; } }) });
  const sending = service.send(record.id, 'hello');
  const rejected = assert.rejects(sending, /关闭/);
  await started.promise;
  await service.stop();
  release.resolve();
  await rejected;
  assert.equal(instances[0].closed, true);
  assert.equal(gatewayClosed, true);
  assert.equal(service.engines.size, 0);
  assert.equal(instances[0].calls.some(call => call.method === 'turn/start'), false);
});

test('account startup failure closes the engine before releasing its reference', async t => {
  const instances = [];
  class FailedEngine extends Engine {
    constructor(options) { super(options); instances.push(this); }
    async start() { throw Error('initialize timeout'); }
    close() { this.closed = true; }
  }
  const { service } = await fixture(t, { Engine: FailedEngine });
  await assert.rejects(service.account('account/read'), /initialize timeout/);
  assert.equal(instances[0].closed, true);
  assert.equal(service.accountEngine, null);
});

test('simultaneous account reads share a single starting engine', async t => {
  const launching = deferred();
  const instances = [];
  class AccountEngine extends Engine {
    constructor(options) { super(options); instances.push(this); }
    close() { this.closed = true; }
  }
  const { service } = await fixture(t, { Engine: AccountEngine });
  service.runtime = { launch: async () => { await launching.promise; return runtime.launch(); } };
  const one = service.account('account/read');
  const two = service.account('account/read');
  launching.resolve();
  await Promise.all([one, two]);
  assert.equal(instances.length, 1);
  await service.stop();
  assert.equal(instances[0].closed, true);
});

test('catalog changes reconnect the next turn to the same thread and retire old tool handles', async t => {
  const instances = [];
  let changed = false;
  const gateways = [];
  class RefreshEngine extends Engine {
    constructor(options) { super(options); instances.push(this); }
    close() { this.closed = true; this.onExit(); }
  }
  const { service, record } = await fixture(t, { Engine: RefreshEngine, createGateway: () => {
    const value = { ...gateway(), refreshCatalog: async () => changed,
      close: async () => { value.closed = true; } };
    gateways.push(value);
    return value;
  } });
  await service.send(record.id, 'first');
  instances[0].onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await service.send(record.id, 'same catalog');
  assert.equal(instances.length, 1);
  instances[0].onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  changed = true;
  await service.send(record.id, 'new catalog');
  assert.equal(instances.length, 2);
  assert.equal(instances[0].closed, true);
  assert.equal(gateways[0].closed, true);
  assert.deepEqual(instances[1].calls[0], { method: 'thread/resume', params: { threadId: 'native-thread', cwd: record.cwd } });
  assert.equal(service.read(record.id).events.filter(event => event.method === 'user/message').length, 3);
});

test('stop during account initialization closes it and prevents account requests', async t => {
  const started = deferred();
  const release = deferred();
  let accountEngine;
  class SlowAccountEngine extends Engine {
    constructor(options) { super(options); accountEngine = this; }
    async start() { started.resolve(); await release.promise; }
    close() { this.closed = true; }
  }
  const { service } = await fixture(t, { Engine: SlowAccountEngine });
  const reading = service.account('account/read');
  const rejected = assert.rejects(reading, /关闭/);
  await started.promise;
  await service.stop();
  release.resolve();
  await rejected;
  assert.equal(accountEngine.closed, true);
  assert.equal(accountEngine.calls.length, 0);
  assert.equal(service.accountEngine, null);
});


test('enabling capture reconnects only the selected next turn and resumes the existing native thread', async t => {
  let key = null;
  const launches = [];
  const engines = [];
  class CapturedEngine extends Engine {
    constructor(options) { super(options); engines.push(this); }
    async start(launch) { launches.push(launch); }
    close() { this.closed = true; }
  }
  const { service, record } = await fixture(t, { Engine: CapturedEngine,
    capture: { key: () => key, prepare: async (_record, launch) => ({ ...launch, key, args: key ? ['-c', 'capture=true'] : [] }) } });
  await service.send(record.id, 'first');
  key = 'capture-route';
  assert.equal(engines.length, 1, 'selection alone cannot interrupt a running turn');
  engines[0].onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await service.send(record.id, 'second');
  assert.equal(engines.length, 2);
  assert.equal(engines[0].closed, true);
  assert.equal(engines[1].calls[0].method, 'thread/resume');
  assert.equal(engines[1].calls[0].params.threadId, 'native-thread');
  assert.ok(launches[1].args.includes('capture=true'));
});
