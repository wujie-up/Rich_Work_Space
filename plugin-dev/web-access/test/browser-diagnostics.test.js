import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(fetch, overrides = {}) {
  const source = await readFile(new URL('../assistants/Shared/Client/BrowserDiagnostics.swift', import.meta.url), 'utf8');
  const script = source.match(/#"""\n([\s\S]*?)\n\s*"""#/)[1].replaceAll('__WORKSPACE_ORIGIN__', '"https://127.0.0.1:51000"');
  const records = [];
  const errors = [];
  const window = { fetch, webkit: { messageHandlers: { workDeskResources: { postMessage: value => records.push(value) } } } };
  window.top = window;
  const context = { window, location: { origin: 'https://127.0.0.1:51000' }, URL, performance,
    console: { error: (...args) => errors.push(args) }, ...overrides };
  vm.runInNewContext(script, context);
  return { window, records, errors };
}

const options = { method: 'POST', body: JSON.stringify({ method: 'plugins.invoke', args: ['ai-agent-sessions', 'sessions.list', ['private-data']] }) };

test('RPC diagnostics distinguish headers and body completion without consuming or exposing payloads', async () => {
  const value = { ok: true, value: ['private-response'] };
  const response = { status: 200, headers: new Headers({ 'content-length': '123' }), json: async () => value };
  const { window, records } = await fixture(async () => response);
  assert.equal(await window.fetch('/api/rpc', options), response);
  assert.equal(await response.json(), value);
  assert.deepEqual(records.map(record => record.phase), ['start', 'headers', 'complete']);
  assert.equal(records[0].method, 'plugins.invoke');
  assert.equal(records[0].plugin, 'ai-agent-sessions');
  assert.equal(records[0].call, 'sessions.list');
  assert.equal(records[1].bytes, '123');
  assert.doesNotMatch(JSON.stringify(records), /private-data|private-response/);
});

test('network and body failures retain the original error and identify the failing stage', async () => {
  const failure = new TypeError('secret error with credentials');
  const first = await fixture(async () => { throw failure; });
  await assert.rejects(first.window.fetch('/api/rpc', options), error => error === failure);
  assert.equal(first.records.at(-1).phase, 'fetch-failed');
  const response = { status: 200, headers: new Headers(), json: async () => { throw failure; } };
  const second = await fixture(async () => response);
  await second.window.fetch('/api/rpc', options);
  await assert.rejects(response.json(), error => error === failure);
  assert.equal(second.records.at(-1).phase, 'body-failed');
  assert.doesNotMatch(JSON.stringify([...first.records, ...second.records]), /secret|credentials/);
});

test('diagnostics ignore foreign origins and non-RPC bodies, and cap emitted metadata', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { status: 200, headers: new Headers(), json: async () => ({ ok: false }) }; };
  const foreign = await fixture(fetch, { location: { origin: 'https://127.0.0.1:51001' } });
  assert.equal(foreign.window.fetch, fetch);
  const { window, records, errors } = await fixture(fetch);
  await window.fetch('/api/login', { method: 'POST', body: 'password' });
  await window.fetch('https://example.com/api/rpc', options);
  assert.equal(records.length, 0);
  const malformed = { method: 'POST', body: 'private-invalid-json' };
  await window.fetch('/api/rpc', malformed);
  for (let index = 0; index < 200; index++) {
    const response = await window.fetch('/api/rpc', options);
    await response.json();
  }
  assert.equal(records.length, 512);
  assert.equal(calls, 203);
  assert.ok(records.some(record => record.phase === 'rpc-error'));
  assert.doesNotMatch(JSON.stringify(errors), /private-invalid-json|private-data/);
});

test('a broken diagnostic sink cannot fail a successful RPC', async () => {
  const value = { ok: true };
  const response = { status: 200, headers: new Headers(), json: async () => value };
  const { window, errors } = await fixture(async () => response);
  window.webkit.messageHandlers.workDeskResources.postMessage = () => { throw Error('private sink detail'); };
  assert.equal(await window.fetch('/api/rpc', options), response);
  assert.equal(await response.json(), value);
  assert.equal(errors.length, 3);
  assert.doesNotMatch(JSON.stringify(errors), /private sink detail/);
});
