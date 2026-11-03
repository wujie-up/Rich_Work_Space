import test from 'node:test';
import assert from 'node:assert/strict';

test('native file and directory pickers may wait for the user while ordinary requests still time out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previousWindow = globalThis.window;
  const previousParent = globalThis.parent;
  const messages = [];
  let receive;
  globalThis.window = { addEventListener: (_name, handler) => { receive = handler; } };
  globalThis.parent = { postMessage: message => messages.push(message) };
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.parent = previousParent;
  });
  const { request } = await import('../src/renderer/bridge.js');
  const results = [];
  const pending = ['host.chooseFile', 'host.chooseDirectory', 'storage.getPreferences'].map(method =>
    request(method).then(value => results.push(value), error => results.push(error.message)));
  t.mock.timers.tick(26000);
  await Promise.resolve();
  assert.deepEqual(results, ['桌面连接超时']);
  for (const message of messages.slice(0, 2)) {
    receive({ source: globalThis.parent, origin: 'desk-host://desktop',
      data: { type: 'desk:result', id: message.id, value: message.method === 'host.chooseFile' ? '/tmp/API.md' : null } });
  }
  await Promise.all(pending);
  assert.deepEqual(results, ['桌面连接超时', '/tmp/API.md', null]);
});

test('launch requests only dispatch from the trusted host window and origin', async t => {
  const previousWindow = globalThis.window;
  const previousParent = globalThis.parent;
  const dispatched = [];
  let receive;
  globalThis.window = {
    addEventListener: (_name, handler) => { receive = handler; },
    dispatchEvent: event => dispatched.push(event)
  };
  globalThis.parent = {};
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.parent = previousParent;
  });
  await import('../src/renderer/bridge.js?launch');
  const data = { type: 'desk:launch', context: { path: '/tmp/new.md' } };
  receive({ source: {}, origin: 'desk-host://desktop', data });
  receive({ source: parent, origin: 'https://untrusted.invalid', data });
  assert.equal(dispatched.length, 0);
  receive({ source: parent, origin: 'desk-host://desktop', data });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'editor-launch');
  assert.deepEqual(dispatched[0].detail, data.context);
});
