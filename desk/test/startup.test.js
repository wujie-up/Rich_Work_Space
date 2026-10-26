import test from 'node:test';
import assert from 'node:assert/strict';
import { startupProfile } from '../src/main/common/startup-profile.js';
import { ensureInstallation } from '../src/main/os/mac/index.js';

test('production profiles share one lock directory; only explicit tests use isolated data', () => {
  assert.deepEqual(startupProfile('/saved', []), { directory: '/saved/Work Desk', testing: false });
  assert.deepEqual(startupProfile('/saved', ['--desk-data=/other']), { directory: '/saved/Work Desk', testing: false });
  assert.deepEqual(startupProfile('/saved', ['--desk-test', '--desk-data=relative']), { directory: '/saved/Work Desk', testing: false });
  assert.deepEqual(startupProfile('/saved', ['--desk-test']), { directory: '/saved/Work Desk', testing: false });
  assert.deepEqual(startupProfile('/saved', ['--desk-test', '--desk-data=/test']), { directory: '/test', testing: true });
});

test('mac packaged copies relocate into Applications and stop startup until relaunch', async () => {
  const calls = [];
  const app = { isPackaged: true, isInApplicationsFolder: () => false,
    moveToApplicationsFolder: () => { calls.push('move'); return true; } };
  assert.equal(await ensureInstallation(app, async () => {}), false);
  assert.deepEqual(calls, ['move']);
  app.isInApplicationsFolder = () => true;
  assert.equal(await ensureInstallation(app, async () => {}), true);
  assert.deepEqual(calls, ['move']);
  app.isPackaged = false;
  app.isInApplicationsFolder = () => false;
  assert.equal(await ensureInstallation(app, async () => {}), true);
  assert.deepEqual(calls, ['move']);
  app.isPackaged = true;
  app.moveToApplicationsFolder = () => false;
  await assert.rejects(ensureInstallation(app, async () => {}), /安装/);
});
