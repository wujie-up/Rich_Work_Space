import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/resource/computer.js', import.meta.url), 'utf8');

// Run the shipped JXA against an OS boundary double; no real keyboard or application is touched.
function desktop({ available = true, activated = true, focusAfter = 1 } = {}) {
  const events = [];
  let frontmost = 1;
  let turns = 0;
  const target = { processIdentifier: 2, activateWithOptions: () => activated };
  const bridge = Object.assign(value => ({ dataUsingEncoding: () => value }), {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: id => {
      assert.equal(id, 'com.google.Chrome');
      return { count: available ? 1 : 0, objectAtIndex: () => target };
    } },
    NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { processIdentifier: frontmost }; } } },
    NSRunLoop: { currentRunLoop: { runUntilDate: () => { if (++turns >= focusAfter) { frontmost = 2; } } } },
    NSDate: { dateWithTimeIntervalSinceNow: seconds => seconds },
    NSApplicationActivateIgnoringOtherApps: 2,
    kCGEventFlagMaskCommand: 1, kCGEventFlagMaskControl: 2, kCGEventFlagMaskAlternate: 4, kCGEventFlagMaskShift: 8,
    NSScreen: { screens: { objectAtIndex: () => ({ frame: { size: { width: 1280, height: 800 } } }) } },
    AXIsProcessTrusted: () => true,
    CGEventCreateKeyboardEvent: () => ({}), CGEventSetFlags: () => {}, CGEventSetType: () => {},
    CGEventKeyboardSetUnicodeString: () => {}, CFDataGetBytePtr: value => value,
    CGPointMake: (x, y) => ({ x, y }), CGEventCreateMouseEvent: () => ({}),
    CGEventCreateScrollWheelEvent: () => ({}),
    CGEventPost: () => events.push(frontmost),
    NSThread: { sleepForTimeInterval: () => {} }
  });
  const context = { ObjC: { import: () => {}, bindFunction: () => {} }, $: bridge };
  runInNewContext(source, context);
  return { events, run: input => JSON.parse(context.run([JSON.stringify(input)])), get frontmost() { return frontmost; } };
}

test('targeted input waits for Chrome to become frontmost after approval stole focus', () => {
  for (const input of [{ action: 'key', key: 'CMD+L' }, { action: 'type', text: 'https://example.com/' },
    { action: 'click', x: 10, y: 12 }, { action: 'scroll', amount: 10 }]) {
    const screen = desktop({ focusAfter: 3 });
    screen.run({ ...input, bundleId: 'com.google.Chrome' });
    assert.ok(screen.events.length > 0);
    assert.ok(screen.events.every(pid => pid === 2), `${input.action} must never reach DeskPG`);
  }
});

test('unavailable or unactivated targets never fall back to typing into DeskPG', () => {
  for (const options of [{ available: false }, { activated: false }, { focusAfter: Infinity }]) {
    const screen = desktop(options);
    assert.throws(() => screen.run({ action: 'type', text: 'private', bundleId: 'com.google.Chrome' }), /目标/);
    assert.deepEqual(screen.events, []);
  }
});

test('targeted screenshot dimensions are measured only after activating the target', () => {
  const screen = desktop();
  assert.deepEqual(screen.run({ action: 'dimensions', bundleId: 'com.google.Chrome' }), { imageWidth: 1280, imageHeight: 800 });
  assert.equal(screen.frontmost, 2);
  assert.deepEqual(screen.events, []);
});

test('calls without a target retain current foreground behavior', () => {
  const screen = desktop();
  screen.run({ action: 'key', key: 'ENTER' });
  assert.deepEqual(screen.events, [1, 1]);
});
