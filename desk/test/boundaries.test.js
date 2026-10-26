import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.(js|cjs)$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat();
}

test('desktop sources contain no business imports or platform branches outside os entry points', async () => {
  for (const path of await sources(resolve('desk/src'))) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"][^'"]*(?:ai-agent|xterm|adapters|sessions|git\.js)/, path);
    assert.doesNotMatch(source, /new Sessions\b|createCodexAdapter|sessions\.create|sessions\.write/, path);
    if (!path.endsWith('/os/index.js')) {
      assert.doesNotMatch(source, /process\.platform/, path);
    }
  }
  for (const path of await sources(resolve('plugin-dev/ai-agent/src/main/common'))) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /process\.platform/, path);
  }
  const desktop = await readFile(resolve('desk/dist/renderer/app.js'), 'utf8');
  assert.doesNotMatch(desktop, /xterm\.css|createCodexAdapter|class Sessions|codex-tui/);
});
