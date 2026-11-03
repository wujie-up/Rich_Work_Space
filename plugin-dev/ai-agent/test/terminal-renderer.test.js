import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTerminalRenderer } from '../src/renderer/terminal-renderer.js';

const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', platform: 'iPhone', maxTouchPoints: 5 };
const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
const desktop = { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/145 Electron/40', platform: 'MacIntel', maxTouchPoints: 0 };

function fixture(browser) {
  let loaded = 0;
  let disposed = 0;
  let lost;
  const addon = { onContextLoss: callback => { lost = callback; return { dispose() {} }; }, dispose: () => { disposed++; } };
  const cleanup = mountTerminalRenderer({ loadAddon: () => { loaded++; } }, { id: 'render-test' }, browser, () => addon);
  return { loaded, cleanup, lose: () => lost(), disposed: () => disposed };
}

test('iPhone and desktop-mode iPad keep the readable DOM terminal renderer', () => {
  for (const browser of [iphone, ipad]) {
    const probe = fixture(browser);
    assert.equal(probe.loaded, 0);
    probe.cleanup();
  }
});

test('desktop retains GPU acceleration and falls back after context loss', () => {
  const probe = fixture(desktop);
  assert.equal(probe.loaded, 1);
  probe.lose();
  assert.equal(probe.disposed(), 1);
  probe.cleanup();
});
