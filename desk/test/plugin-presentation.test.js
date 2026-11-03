import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginEvents } from '../src/renderer/plugin-events.js';
import { pageLifecycle, pollVisible } from '../src/resource/page-lifecycle.js';

class Target extends EventTarget {
  send(type, values = {}) {
    this.dispatchEvent(Object.assign(new Event(type), values));
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('one event subscription targets only matching plugin frames and validates message ownership', () => {
  const target = new Target();
  let subscriptions = 0;
  let unsubscribed = 0;
  let publish;
  const router = new PluginEvents(target, callback => {
    subscriptions++;
    publish = callback;
    return () => { unsubscribed++; };
  });
  const frames = Array.from({ length: 100 }, () => ({}));
  let deliveries = 0;
  let received = 0;
  const cleanup = frames.map((source, i) => router.add(source, i < 2 ? 'one' : `other-${i}`, () => received++, () => deliveries++));
  assert.equal(subscriptions, 1);
  publish({ pluginId: 'one', channel: 'progress' });
  assert.equal(deliveries, 2);
  target.send('message', { source: frames[0], origin: 'desk-plugin://other', data: {} });
  target.send('message', { source: {}, origin: 'desk-plugin://one', data: {} });
  assert.equal(received, 0);
  target.send('message', { source: frames[0], origin: 'desk-plugin://one', data: {} });
  assert.equal(received, 1);
  cleanup.forEach(off => off());
  assert.equal(unsubscribed, 1);
  assert.equal(router.plugins.size, 0);
  assert.equal(router.frames.size, 0);
});

test('hidden presentation stops polling, resumes once, and never overlaps requests', async () => {
  const target = new Target();
  target.parent = { postMessage() {} };
  const page = new Target();
  page.hidden = false;
  const lifecycle = pageLifecycle(target, page);
  let work = 0;
  let complete;
  const timers = new Set();
  const stop = pollVisible(lifecycle, () => { work++; return new Promise(resolve => { complete = resolve; }); }, 1000,
    { schedule: callback => { timers.add(callback); return callback; }, cancel: callback => timers.delete(callback) });
  const show = visible => target.send('message', { source: target.parent, origin: 'desk-host://desktop', data: { type: 'desk:visibility', visible } });
  assert.equal(work, 1);
  show(false);
  show(true);
  assert.equal(work, 1);
  show(false);
  complete();
  await settle();
  assert.equal(timers.size, 0);
  // Untrusted frames cannot resume another plugin's presentation work.
  target.send('message', { source: {}, origin: 'desk-host://desktop', data: { type: 'desk:visibility', visible: true } });
  assert.equal(work, 1);
  show(true);
  assert.equal(work, 2);
  complete();
  await settle();
  assert.equal(timers.size, 1);
  page.hidden = true;
  page.send('visibilitychange');
  assert.equal(timers.size, 0);
  page.hidden = false;
  page.send('visibilitychange');
  assert.equal(work, 3);
  target.send('pagehide');
  complete();
  await settle();
  assert.equal(timers.size, 0);
  stop();
});
