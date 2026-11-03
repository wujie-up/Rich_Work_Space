import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../src/main/common/browser-session.js';
import { runInNewContext } from 'node:vm';

test('browser startup is shared, uses its own profile and exposes no debugger or cookies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launches = 0;
  let closes = 0;
  let accountId = 'person';
  const page = { url: () => 'https://example.pingcode.com/pjm/projects', goto: async () => {}, bringToFront: async () => {},
    isClosed: () => false, evaluate: async () => ({ status: 200, body: { code: 200, data: { me: { uid: accountId } } } }) };
  const session = new BrowserSession({ root, platform: { launch: async profile => {
    launches++;
    assert.ok(profile.startsWith(root));
    return { endpoint: 'ws://secret-debugger', close: async () => { closes++; } };
  } }, connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }) });
  session.open('https://example.pingcode.com');
  session.open('https://example.pingcode.com');
  await session.check();
  assert.equal(launches, 1);
  assert.equal(session.status().state, 'connected');
  const authenticatedEpoch = session.status().epoch;
  await session.check();
  assert.equal(session.status().epoch, authenticatedEpoch, 'automatic same-user checks must not invalidate a query');
  accountId = 'another-person';
  await session.check();
  assert.notEqual(session.status().epoch, authenticatedEpoch, 'a different account must invalidate previous results');
  assert.equal(JSON.stringify(session.status()).includes('secret-debugger'), false);
  const epoch = session.status().epoch;
  await assert.rejects(session.read('https://other.pingcode.com', '/api/agile/entries'), /站点/);
  await assert.rejects(session.read('https://example.pingcode.com', '//evil.example/api'), /请求/);
  await session.close();
  assert.equal(closes, 1);
  assert.notEqual(session.status().epoch, epoch);
  assert.equal(session.status().state, 'closed');
});

test('expired login and malformed responses do not become successful auth or expose server data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = { url: () => 'https://example.pingcode.com/pjm/projects', goto: async () => {}, bringToFront: async () => {},
    isClosed: () => false, evaluate: async () => ({ status: 401, body: { message: 'secret-cookie' } }) };
  const session = new BrowserSession({ root, platform: { launch: async () => ({ endpoint: 'ws://unused', close: async () => {} }) },
    connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }) });
  session.open('https://example.pingcode.com');
  const state = await session.check();
  assert.equal(state.state, 'needs-login');
  assert.equal(JSON.stringify(state).includes('secret-cookie'), false);
  await session.close();
});

test('logout blocks another view from opening a browser until cleanup has completed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-browser-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launches = 0;
  let finishClose;
  let slow = true;
  const page = { url: () => 'https://example.pingcode.com/pjm/projects', goto: async () => {}, bringToFront: async () => {},
    isClosed: () => false, evaluate: async () => ({ status: 200, body: { code: 200, data: { me: { uid: 'person' } } } }) };
  const session = new BrowserSession({ root, platform: { launch: async () => {
    launches++;
    return { endpoint: 'ws://unused', close: async () => {} };
  } }, connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {
    if (slow) {
      await new Promise(resolve => { finishClose = resolve; });
    }
  } }) });
  session.open('https://example.pingcode.com');
  await session.check();
  const profile = session.profile;
  await writeFile(join(profile, 'retained-fixture'), 'fixture');
  const closing = session.close();
  const logout = session.close({ logout: true });
  const duringClose = session.open('https://example.pingcode.com');
  assert.equal(duringClose.state, 'closing');
  assert.equal(launches, 1);
  slow = false;
  finishClose();
  await Promise.all([closing, logout]);
  await assert.rejects(readFile(join(profile, 'retained-fixture')), { code: 'ENOENT' });
  session.open('https://example.pingcode.com');
  assert.equal((await session.check()).state, 'connected');
  assert.equal(launches, 2);
  await session.close();
});

async function fakeSession(t, evaluate, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-browser-case-'));
  const page = { url: () => 'https://example.pingcode.com/pjm/projects', goto: async () => {}, bringToFront: async () => {},
    isClosed: () => false, evaluate };
  const session = new BrowserSession({ root, requestTimeoutMs: 30, ...options,
    platform: { launch: async () => ({ endpoint: 'ws://fixture', close: async () => {} }) },
    connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }) });
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true }); });
  session.open('https://example.pingcode.com');
  await session.opening;
  return session;
}

test('a temporary network failure can be checked again without clearing the login profile', async t => {
  let broken = true;
  const session = await fakeSession(t, async () => broken ? { failure: 'network' }
    : { status: 200, body: { code: 200, data: { me: { uid: 'person' } } } });
  assert.equal((await session.check()).state, 'error');
  broken = false;
  assert.equal(session.open('https://example.pingcode.com').state, 'needs-login');
  assert.equal((await session.check()).state, 'connected');
});

test('fetch rechecks the actual page origin before reading and invalidates the old session', async t => {
  let fetches = 0;
  const session = await fakeSession(t, (fn, args) => runInNewContext(`(${fn.toString()})(args)`, {
    args, location: { origin: 'https://different.example' }, URL, AbortController, setTimeout, clearTimeout,
    fetch: async () => { fetches++; return { status: 200, json: async () => ({ code: 200, data: { me: {} } }) }; }
  }));
  const previous = session.status().epoch;
  assert.equal((await session.check()).state, 'needs-login');
  assert.equal(fetches, 0);
  assert.notEqual(session.status().epoch, previous);
});

test('a frozen page cannot block Node-side cancellation, timeout or session shutdown', async t => {
  const session = await fakeSession(t, () => new Promise(() => {}));
  const guard = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('test deadline')), 250))]);
  const controller = new AbortController();
  const cancelled = session.read('https://example.pingcode.com', '/api/agile/work-items', {}, controller.signal);
  controller.abort();
  await assert.rejects(guard(cancelled), error => error.code === 'CANCELLED');
  await assert.rejects(guard(session.read('https://example.pingcode.com', '/api/agile/work-items')), error => error.code === 'TIMEOUT');
  const reading = session.read('https://example.pingcode.com', '/api/agile/work-items');
  const rejected = assert.rejects(guard(reading), error => error.code === 'CANCELLED');
  await session.close();
  await rejected;
});

test('a missing account invalidates the previous login epoch and old query identity', async t => {
  const session = await fakeSession(t, async () => ({ status: 200, body: { code: 200, data: { me: null } } }));
  const previous = session.status().epoch;
  assert.equal((await session.check()).state, 'needs-login');
  assert.notEqual(session.status().epoch, previous);
});
