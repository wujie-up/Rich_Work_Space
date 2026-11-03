import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, readInPage } from '../src/browser-extension/commands.js';

const site = 'https://example.pingcode.com';
test('extension commands reuse site tabs, create a tab only when missing, and restrict injected reads', async () => {
  const calls = [];
  let tabs = [{ id: 7, windowId: 3, status: 'complete', active: true }];
  const commands = createCommands({
    tabs: { query: async query => { calls.push(['query', query]); return tabs; },
      create: async options => { calls.push(['create', options]); return { id: 8, status: 'complete' }; },
      update: async (...args) => calls.push(['update', ...args]) },
    windows: { update: async (...args) => calls.push(['focus', ...args]) },
    scripting: { executeScript: async args => { calls.push(['script', args]); return [{ result: { status: 200 } }]; } }
  });
  await commands.execute({ id: 'open', action: 'open', site });
  assert.equal(calls.filter(row => row[0] === 'create').length, 0);
  assert.equal(calls.some(row => row[0] === 'focus'), true);
  await commands.execute({ id: 'read', action: 'read', site, path: '/api/agile/work-items', params: { pi: 0 } });
  const script = calls.find(row => row[0] === 'script')[1];
  assert.equal(script.world, 'ISOLATED');
  assert.equal(script.target.tabId, 7);
  assert.equal(script.func, readInPage);
  tabs = [];
  await commands.execute({ id: 'new', action: 'open', site });
  assert.equal(calls.filter(row => row[0] === 'create').length, 1);
  for (const change of [{ site: 'https://evil.example' }, { path: '/api/agile/../auth/token' }, { action: 'write' }]) {
    await assert.rejects(commands.execute({ id: 'bad', action: 'read', site, path: '/api/agile/work-items', ...change }));
  }
});

test('injected read rechecks the actual tab origin before any fetch', async () => {
  const before = globalThis.location;
  try {
    globalThis.location = { origin: 'https://evil.example' };
    assert.deepEqual(await readInPage({ site, path: '/api/agile/work-items', id: 'one' }), { failure: 'site' });
  } finally { globalThis.location = before; }
});

test('disconnect during tab lookup cannot open or focus a tab afterwards', async () => {
  let resolveLookup;
  let created = 0;
  const commands = createCommands({ tabs: {
    query: () => new Promise(resolve => { resolveLookup = resolve; }),
    create: async () => { created++; return { id: 1, status: 'complete' }; }
  } });
  const pending = commands.execute({ id: 'cancelled', action: 'open', site });
  await commands.cancelAll();
  resolveLookup([]);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(created, 0);
});
