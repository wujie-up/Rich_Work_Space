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
  const cleanup = [];
  const storage = await temporaryStore({ after: work => cleanup.push(work) });
  const service = new Conversations({ storage, pluginId: 'ai-test', runtime, Engine, createGateway: gateway,
    emit: () => {}, ownProcesses: () => {}, ...options });
  await service.load();
  t.after(async () => {
    await service.stop();
    for (const work of cleanup) { await work(); }
  });
  return { service, record: await service.create({ cwd: storage.root }) };
}

test('native MCP forms and URL decisions return typed responses once and retire resolved numeric request IDs', async t => {
  const { service, record } = await fixture(t);
  await service.send(record.id, 'native input');
  const { engine } = service.engines.get(record.id);
  for (const [index, decision] of ['accept', 'decline', 'cancel'].entries()) {
    const id = index;
    engine.onEvent({ id, method: 'mcpServer/elicitation/request', params: {
      threadId: 'native-thread', turnId: 'native-turn', serverName: 'fixture', mode: 'form', message: 'Input',
      requestedSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, count: { type: 'integer' } }, required: ['enabled'] }
    } });
    if (decision === 'accept') { assert.throws(() => service.elicit(record.id, id, decision, { enabled: 'false' }), /格式/); }
    service.elicit(record.id, id, decision, { enabled: false, count: 0 });
    assert.deepEqual(engine.response, { id, result: { action: decision,
      ...(decision === 'accept' ? { content: { enabled: false, count: 0 } } : {}) } });
    assert.throws(() => service.elicit(record.id, id, decision, {}), /失效/);
    assert.equal((await service.read(record.id)).events.at(-1).params.answers, undefined);
  }
  engine.onEvent({ id: 44, method: 'mcpServer/elicitation/request', params: {
    threadId: 'native-thread', mode: 'url', url: 'https://example.com/auth', elicitationId: 'fixture', message: 'Authorize'
  } });
  service.elicit(record.id, 44, 'accept');
  assert.deepEqual(engine.response, { id: 44, result: { action: 'accept' } });
  engine.onEvent({ id: 45, method: 'mcpServer/elicitation/request', params: { mode: 'url' } });
  engine.onEvent({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 45 } });
  assert.throws(() => service.elicit(record.id, 45, 'accept'), /失效/);
  assert.equal((await service.read(record.id)).events.at(-1).method, 'serverRequest/resolved');
});

test('MCP input expires with its turn and cannot masquerade as tool approval', async t => {
  const { service, record } = await fixture(t);
  await service.send(record.id, 'native input');
  const { engine } = service.engines.get(record.id);
  engine.onEvent({ id: 'expired', method: 'mcpServer/elicitation/request', params: {
    threadId: 'native-thread', turnId: 'native-turn', mode: 'url'
  } });
  engine.onEvent({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } });
  assert.throws(() => service.elicit(record.id, 'expired', 'accept'), /失效/);
  engine.onEvent({ id: 'approval', method: 'mcpServer/elicitation/request', params: {
    mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }
  } });
  assert.throws(() => service.elicit(record.id, 'approval', 'accept', {}), /失效/);
});

test('child completion and stale turns cannot finish or interrupt the active parent conversation', async t => {
  const { service, record } = await fixture(t);
  await service.send(record.id, 'delegate work');
  const { engine } = service.engines.get(record.id);
  for (const [threadId, id, status] of [
    ['child-thread', 'child-turn', 'completed'], ['child-thread', 'child-turn', 'failed'],
    ['native-thread', 'previous-turn', 'completed']
  ]) {
    engine.onEvent({ method: 'turn/completed', params: { threadId, turn: { id, rootTurnId: 'native-turn', status } } });
    const current = await service.read(record.id);
    assert.equal(current.state, 'running');
    assert.equal(current.turnId, 'native-turn');
  }
  engine.onEvent({ id: 42, method: 'item/tool/requestUserInput', params: {
    threadId: 'child-thread', turnId: 'child-turn', questions: [{ id: 'scope', question: '确认范围？' }]
  } });
  assert.ok((await service.read(record.id)).events.some(event => event.id === 42));
  engine.onEvent({ method: 'turn/completed', params: {
    threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' }
  } });
  assert.equal((await service.read(record.id)).state, 'idle');
});

test('stream persistence coalesces queued snapshots and flushes updates received during a write', async () => {
  const started = deferred();
  const release = deferred();
  const saved = [];
  const service = new Conversations({ pluginId: 'ai-test', storage: { async writeJson(key, value) {
    saved.push(value);
    if (saved.length === 1) {
      started.resolve();
      await release.promise;
    }
  } } });
  const record = { id: '00000000-0000-4000-8000-000000000001', events: [] };
  const pending = [];
  for (let index = 0; index < 100; index += 1) {
    record.events.push({ sequence: index });
    pending.push(service.persist(record));
  }
  await started.promise;
  record.events.push({ sequence: 100 });
  pending.push(service.persist(record));
  release.resolve();
  await Promise.all(pending);
  assert.equal(saved.filter(value => value.id).length, 2);
  assert.equal(saved[0].events.length, 100);
  assert.deepEqual(saved[1].events, record.events);
  assert.equal(service.pendingWrites.size, 0);
});

test('a slow conversation write does not block another conversation and stop drains pending events', { timeout: 1000 }, async () => {
  const started = deferred();
  const release = deferred();
  const saved = [];
  const first = { id: '00000000-0000-4000-8000-000000000001', events: [] };
  const second = { id: '00000000-0000-4000-8000-000000000002', events: [] };
  const service = new Conversations({ pluginId: 'ai-test', ownProcesses() {}, storage: { async writeJson(key, value) {
    if (value.id === first.id) {
      started.resolve();
      await release.promise;
    }
    saved.push(value);
  } } });
  const writing = service.persist(first);
  await started.promise;
  let stopping;
  try {
    await service.persist(second);
    assert.equal(saved[0].id, second.id);
    let stopped = false;
    stopping = service.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
  } finally {
    release.resolve();
  }
  await stopping;
  await writing;
  assert.equal(saved.filter(value => value.id).length, 2);
});

test('failed conversation persistence rejects callers and allows the latest state to be retried', async () => {
  let fail = true;
  let saved;
  const service = new Conversations({ pluginId: 'ai-test', storage: { async writeJson(key, value) {
    if (fail) { throw Error('disk full'); }
    saved = value;
  } } });
  const record = { id: '00000000-0000-4000-8000-000000000001', events: [] };
  const results = await Promise.allSettled([service.persist(record), service.persist(record)]);
  assert.equal(results.every(result => result.status === 'rejected' && result.reason.message === 'disk full'), true);
  fail = false;
  record.events.push({ sequence: 1 });
  await service.persist(record);
  assert.deepEqual(saved.events, record.events);
  assert.equal(service.pendingWrites.size, 0);
});

test('stop closes an engine during startup and prevents the pending send from starting a turn', async t => {
  const started = deferred();
  const release = deferred();
  const instances = [];
  let gatewayClosed = false;
  let nativeClosed = false;
  class SlowEngine extends Engine {
    constructor(options) { super(options); instances.push(this); }
    async start() { started.resolve(); await release.promise; }
    close() { this.closed = true; }
  }
  const { service, record } = await fixture(t, { Engine: SlowEngine,
    createNativeMcp: async () => ({ connection: { close: async () => { nativeClosed = true; } }, args: [] }),
    createGateway: () => ({ ...gateway(), close: async () => { gatewayClosed = true; } }) });
  const sending = service.send(record.id, 'hello');
  const rejected = assert.rejects(sending, /关闭/);
  await started.promise;
  await service.stop();
  release.resolve();
  await rejected;
  assert.equal(instances[0].closed, true);
  assert.equal(gatewayClosed, true);
  assert.equal(nativeClosed, true);
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
  assert.equal((await service.read(record.id)).events.filter(event => event.method === 'user/message').length, 3);
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


test('conversation passes its pinned MCP selection to the gateway, including an empty selection', async t => {
  const selection = { mode: 'selected', services: [] };
  let received;
  const { service, record } = await fixture(t, {
    runtime: { ...runtime, launch: async () => ({ ...await runtime.launch(), launchSettings: { mcp: selection } }) },
    createGateway: options => { received = options.selection; return gateway(); }
  });
  await service.send(record.id, 'hello');
  assert.deepEqual(received, selection);
  assert.equal(service.engines.get(record.id).engine.calls[0].params.approvalPolicy, 'on-request');
});


test('workflow threads start and resume with full access without changing ordinary settings', async t => {
  const approvalPolicy = { granular: { sandbox_approval: false, rules: false, skill_approval: false,
    request_permissions: false, mcp_elicitations: true } };
  const selections = [];
  const { service, record } = await fixture(t, {
    runtime: { ...runtime, launch: async () => ({ ...await runtime.launch(), launchSettings: { mcp: { mode: 'selected', services: [] } } }) },
    createGateway: options => { selections.push(options.selection); return gateway(); }
  });
  record.task = { kind: 'plan', background: { authorizationId: 'lease' } };
  await service.connect(record);
  const active = service.engines.get(record.id);
  assert.deepEqual(active.engine.calls[0], { method: 'thread/start', params: {
    cwd: record.cwd, approvalPolicy, sandbox: 'danger-full-access'
  } });
  assert.equal(selections[0], undefined);
  await active.gateway.close();
  active.engine.close();
  service.engines.delete(record.id);
  await service.connect(record);
  assert.deepEqual(service.engines.get(record.id).engine.calls[0], { method: 'thread/resume', params: {
    threadId: record.threadId, cwd: record.cwd, approvalPolicy, sandbox: 'danger-full-access'
  } });
});

test('native MCP connection is reused between turns and closes only with its owning conversation', async t => {
  const connections = [];
  const launches = [];
  class NativeEngine extends Engine {
    async start(launch) { launches.push(launch); }
  }
  const { service, record } = await fixture(t, { Engine: NativeEngine, createNativeMcp: async record => {
    const connection = { id: record.id, refreshed: 0, closed: false,
      async refresh() { this.refreshed++; }, async close() { this.closed = true; } };
    connections.push(connection);
    return { connection, args: ['-c', 'mcp_servers.fixture.url="http://localhost/native"'] };
  } });
  await service.send(record.id, 'first');
  assert.ok(launches[0].args.includes('mcp_servers.fixture.url="http://localhost/native"'));
  const first = service.engines.get(record.id);
  first.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await service.send(record.id, 'second');
  assert.equal(connections.length, 1);
  assert.equal(connections[0].refreshed, 1);
  const peer = await service.create({ cwd: record.cwd });
  await service.send(peer.id, 'peer');
  first.engine.onExit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections[0].closed, true);
  assert.equal(connections[1].closed, false);
  assert.equal(service.engines.has(peer.id), true);
  await service.stop();
  assert.equal(connections[1].closed, true);
});

test('native MCP connection and capability gateway both close when engine initialization fails', async t => {
  let nativeClosed = false;
  let gatewayClosed = false;
  class FailingEngine extends Engine {
    async start() { throw Error('native initialization failed'); }
  }
  const { service, record } = await fixture(t, { Engine: FailingEngine,
    createNativeMcp: async () => ({ connection: { close: async () => { nativeClosed = true; } }, args: [] }),
    createGateway: () => ({ ...gateway(), close: async () => { gatewayClosed = true; } }) });
  await assert.rejects(service.send(record.id, 'first'), /native initialization failed/);
  assert.equal(nativeClosed, true);
  assert.equal(gatewayClosed, true);
  assert.equal(service.engines.size, 0);
});

test('manual reconnect is deferred during a turn and resumes history exactly once before the next user input', async t => {
  const { service, record } = await fixture(t);
  t.after(() => service.stop());
  await service.send(record.id, 'first');
  const original = service.engines.get(record.id).engine;
  assert.deepEqual(await service.reconnect(record.id), { pending: true });
  assert.equal(service.engines.get(record.id).engine, original);
  assert.equal(original.calls.filter(call => call.method === 'turn/start').length, 1);
  original.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await service.send(record.id, 'second');
  const replacement = service.engines.get(record.id).engine;
  assert.notEqual(replacement, original);
  assert.equal(replacement.calls[0].method, 'thread/resume');
  assert.equal(replacement.calls[0].params.threadId, 'native-thread');
  assert.equal(replacement.calls.filter(call => call.method === 'turn/start').length, 1);
  replacement.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  assert.deepEqual(await service.reconnect(record.id), { pending: false });
  assert.notEqual(service.engines.get(record.id).engine, replacement);
  assert.equal(service.engines.get(record.id).engine.calls.filter(call => call.method === 'turn/start').length, 0);
});
