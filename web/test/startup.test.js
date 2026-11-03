import test from 'node:test';
import assert from 'node:assert/strict';
import { browserApi } from '../src/browser/adapter.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(t) {
  const originals = { fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const requests = [];
  let events;
  globalThis.EventSource = class {
    constructor() { events = this; }
    addEventListener() {}
    close() { this.closed = true; }
  };
  globalThis.fetch = async (_, options) => {
    const response = deferred();
    const { method } = JSON.parse(options.body);
    requests.push({ method, resolve: (value, ok = true) => response.resolve({ status: ok ? 200 : 500, ok,
      json: async () => ok ? { value } : { error: { message: value } } }) });
    return response.promise;
  };
  t.after(() => Object.assign(globalThis, originals));
  let revoked = false;
  const api = browserApi({ csrf: 'temporary-test' }, () => { revoked = true; });
  return { api, requests, events, revoked: () => revoked };
}

test('startup reads overlap after subscription and are consumed once without an initial SSE duplicate', async t => {
  const { api, requests, events } = fixture(t);
  assert.deepEqual(requests.map(r => r.method).sort(), ['desktop.list', 'storage.getPreferences']);
  let refreshes = 0;
  api.events.pluginsChanged(() => { refreshes++; });
  events.onopen();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(r => r.method).sort(), ['desktop.list', 'plugins.list', 'storage.getPreferences']);
  assert.equal(refreshes, 0);
  requests.forEach(r => r.resolve(r.method));
  assert.equal(await api.storage.getPreferences(), 'storage.getPreferences');
  assert.equal(await api.plugins.list(), 'plugins.list');
  assert.equal(await api.desktop.list(), 'desktop.list');
  assert.equal(requests.length, 3);
  const second = api.plugins.list();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4);
  requests.at(-1).resolve('fresh');
  assert.equal(await second, 'fresh');
  events.onopen();
  assert.equal(refreshes, 1);
});

test('a change event invalidates a pending startup snapshot', async t => {
  const { api, requests, events } = fixture(t);
  events.onopen();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  const pending = requests.find(r => r.method === 'plugins.list');
  events.onmessage({ data: JSON.stringify({ channel: 'plugins.changed' }) });
  const list = api.plugins.list();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4);
  pending.resolve('outdated');
  requests.at(-1).resolve('current');
  assert.equal(await list, 'current');
  requests.filter(r => !['plugins.list'].includes(r.method)).forEach(r => r.resolve([]));
});

test('prefetch errors keep their original failure and are handled before consumption', async t => {
  const { api, requests, events } = fixture(t);
  events.onopen();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  requests.forEach(r => r.resolve(r.method === 'plugins.list' ? 'original failure' : [], r.method !== 'plugins.list'));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(api.plugins.list(), /original failure/);
});

test('a change arriving after startup consumption cannot return the stale snapshot', async t => {
  const { api, requests, events } = fixture(t);
  events.onopen();
  await new Promise(resolve => setImmediate(resolve));
  const list = api.plugins.list();
  events.onmessage({ data: JSON.stringify({ channel: 'plugins.changed' }) });
  requests.find(r => r.method === 'plugins.list').resolve('outdated');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 4);
  requests.at(-1).resolve('current');
  assert.equal(await list, 'current');
  requests.filter(r => r.method !== 'plugins.list').forEach(r => r.resolve([]));
});

test('a plugin change before event subscription cannot leave an old startup snapshot', async t => {
  const { api, requests, events } = fixture(t);
  const list = api.plugins.list();
  assert.equal(requests.some(r => r.method === 'plugins.list'), false);
  // The server may change plugins before it registers this client's event subscription.
  events.onopen();
  await new Promise(resolve => setImmediate(resolve));
  requests.find(r => r.method === 'plugins.list').resolve('current-after-subscription');
  assert.equal(await list, 'current-after-subscription');
  requests.filter(r => r.method !== 'plugins.list').forEach(r => r.resolve([]));
});
