import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const json = async path => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));

test('桌面版本与 lock 一致，菜单相关插件包与清单一致', async () => {
  const app = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(lock.version, app.version);
  assert.equal(lock.packages[''].version, app.version);
  for (const plugin of ['work-flow', 'ai-agent']) {
    assert.equal((await json(`plugin-dev/${plugin}/package.json`)).version, (await json(`plugin-dev/${plugin}/plugin.json`)).version);
  }
});
