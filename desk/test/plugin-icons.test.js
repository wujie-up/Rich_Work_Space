import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from './helpers.js';
import { PluginIcons } from '../src/main/common/plugin-icons.js';

test('custom static icon stays separate from package, rejects executable SVG, and resets without deleting data', async t => {
  const storage = await temporaryStore(t);
  const icons = new PluginIcons(storage, { record: () => ({ state: 'enabled' }), emit() {}, list: () => [] });
  const source = join(storage.root, 'chosen.svg');
  await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 2h3"/></svg>');
  await icons.set('test-agent', source);
  assert.equal(await icons.path('test-agent'), join(storage.root, 'plugin-icons/test-agent/icon.svg'));
  await writeFile(source, '<svg><script>alert(1)</script></svg>');
  await assert.rejects(icons.set('test-agent', source), { code: 'INVALID_ICON' });
  await writeFile(source, '<svg><path onclick="test()"/></svg>');
  await assert.rejects(icons.set('test-agent', source), { code: 'INVALID_ICON' });
  await icons.reset('test-agent');
  assert.match(await icons.path('test-agent'), /packages\/test-agent\/ico\/icon.svg$/);
  assert.deepEqual(await storage.readJson('plugin-icons/index.json'), {});
});
