import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from './helpers.js';

test('AI entry reuses its frame, custom icons survive reload, tabs retain its window', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false, executablePath: process.env.WORK_DESK_TEST_EXECUTABLE });
  for (const id of ['ai-agent-sessions', 'mcp-services', 'text-editor', 'work-flow']) {
    await page.waitForFunction(id => document.querySelector(`.shelf-app[data-plugin="${id}"] img`)?.naturalWidth > 0, id);
  }
  await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
  const frame = page.locator('iframe.plugin-view').first().contentFrame();
  await frame.locator('body').waitFor();
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'entry'; });
  assert.equal(await page.locator('iframe.plugin-view').count(), 1);
  await page.locator('#desktop').click();
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.equal(await page.locator('.application-window').getAttribute('data-phase'), 'inactive');
  await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
  assert.equal(await page.locator('iframe.plugin-view').count(), 1);
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'entry');
  await page.locator('#desktop').click();
  const source = join(data, 'test-icon.svg');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="none" stroke="black"/></svg>';
  await writeFile(source, svg);
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
  await page.evaluate(() => workDesk.plugins.setIcon('ai-agent-sessions'));
  assert.equal(await readFile(join(data, 'plugin-icons/ai-agent-sessions/icon.svg'), 'utf8'), svg);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.shelf-app[data-plugin="ai-agent-sessions"] img')?.naturalWidth > 0);
  await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
  await page.locator('#desktop').click();
  await mkdir(resolve('plugin-dev/dist/verification/ai-workbench-0.1.9'), { recursive: true });
  await page.waitForFunction(() => [...document.querySelectorAll('.application-window')].every(node => node.dataset.phase === 'inactive' && getComputedStyle(node).visibility === 'hidden'));
  const previous = await page.locator('.shelf-app[data-plugin="ai-agent-sessions"] img').getAttribute('src');
  await page.evaluate(() => workDesk.plugins.resetIcon('ai-agent-sessions'));
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-icons/index.json'), 'utf8')), {});
  await page.waitForFunction(previous => {
    const image = document.querySelector('.shelf-app[data-plugin="ai-agent-sessions"] img');
    return image?.naturalWidth > 0 && image.getAttribute('src') !== previous;
  }, previous);
  await page.screenshot({ path: resolve('plugin-dev/dist/verification/ai-workbench-0.1.9/desktop-icons-tabs.png') });
});
