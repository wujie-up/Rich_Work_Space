import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launch, openConfiguration } from './helpers.js';
import { temporaryStore, fixture } from '../helpers.js';
import { packPackage } from '../../src/main/common/plugin-package.js';

test('native .plg selection imports and enables an isolated plugin', { timeout: 60000 }, async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  const archive = join(storage.root, 'test-agent.plg');
  await packPackage(source, archive);
  const { app, page } = await launch(t, { openPlugin: false,
    ...(process.env.DESK_EXECUTABLE ? { executablePath: process.env.DESK_EXECUTABLE } : {}) });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async (...args) => {
      globalThis.packageDialogOptions = args.at(-1);
      return { canceled: false, filePaths: [archive] };
    };
  }, archive);
  await openConfiguration(page);
  await page.getByRole('button', { name: '导入本地插件', exact: true }).click();
  await page.waitForFunction(async () => (await workDesk.plugins.list()).some((plugin) => plugin.id === 'test-agent' && plugin.state === 'enabled'));
  const options = await app.evaluate(() => globalThis.packageDialogOptions);
  assert.deepEqual(options.properties, ['openFile']);
  assert.deepEqual(options.filters[0].extensions, ['plg']);
  assert.equal(await page.locator('iframe').count(), 0);
});
