import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright';
import { withPackageSource } from '../../../../desk/src/main/common/plugin-package.js';
import { build } from 'esbuild';

test('real workbench loads the distribution, opens independent Chrome and preserves theme, focus and narrow layouts', { timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const data = await mkdtemp(join(tmpdir(), 'ai-browser-ui-'));
  await mkdir(join(data, 'plugins/ai-browser'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'plugin-dev/ai-browser/plugin.json'), 'utf8'));
  await withPackageSource(join(root, `plugin-dev/dist/ai-browser-${manifest.version}.plg`), source => cp(source, join(data, 'plugins/ai-browser'), { recursive: true }));
  const linkFixture = { id: 'html-link-fixture', name: 'HTML link fixture', version: '1.0.0', apiVersion: 2, dataVersion: 1,
    type: 'application', showIcon: true, singleInstance: true, loadOnStartup: false, background: 'none',
    views: [{ id: 'main', title: 'HTML links', entry: 'index.html' }] };
  const linkDirectory = join(data, 'plugins', linkFixture.id);
  await mkdir(linkDirectory, { recursive: true });
  await writeFile(join(linkDirectory, 'plugin.json'), JSON.stringify(linkFixture));
  await writeFile(join(linkDirectory, 'index.html'), '<!doctype html><meta charset="utf-8"><body><script type="module" src="app.js"></script></body>');
  await writeFile(join(data, '报告 预览.html'), '<title>Local HTML report</title><h1>First report</h1>');
  await writeFile(join(data, 'second.htm'), '<title>Second report</title><h1>Second report</h1>');
  // Exercise the actual Agent document-link renderer without starting a model or reading user history.
  await build({ stdin: { contents: `import { renderDocumentLinks } from './plugin-dev/ai-agent/src/renderer/document-links.js';
    renderDocumentLinks(document.body, '[First](报告 预览.html) [Second](second.htm)', ${JSON.stringify(data)});`,
    resolveDir: root, sourcefile: 'agent-html-links.js' }, bundle: true, format: 'esm', outfile: join(linkDirectory, 'app.js') });
  await writeFile(join(data, 'plugins.json'), JSON.stringify([
    { ...manifest, state: 'enabled', autoStart: false }, { ...linkFixture, state: 'enabled', autoStart: false }
  ]));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [root, '--desk-test', `--desk-data=${data}`], env, timeout: 30000 });
  const server = createServer((req, res) => res.end('<title>Independent browser fixture</title><h1>Ready</h1><button>Continue</button>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const startupLogs = [];
  app.process().stderr.on('data', bytes => startupLogs.push(bytes.toString()));
  app.process().stdout.on('data', bytes => startupLogs.push(bytes.toString()));
  let page;
  const errors = [];
  t.after(async () => {
    await page?.evaluate(async () => {
      const preview = await workDesk.plugins.preview('ai-browser', 'disable');
      await workDesk.plugins.disable('ai-browser', preview.confirmationToken);
    }).catch(() => {});
    const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 5000);
    await app.close();
    clearTimeout(watchdog);
    await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  try {
    page = await app.firstWindow();
  } catch (error) {
    throw Error(`${error.message}\n${startupLogs.join('')}`);
  }
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => startupLogs.push(message.text()));
  await page.locator('.shelf-app[data-plugin="ai-browser"]').click();
  const frame = page.frameLocator('iframe.plugin-view[src^="desk-plugin://ai-browser/"]');
  await frame.locator('#state').filter({ hasText: '内核未就绪' }).waitFor();
  assert.equal(await frame.locator('#open').isDisabled(), true);
  await frame.getByLabel('浏览器内核', { exact: true }).selectOption('chrome');
  await page.waitForTimeout(2300);
  assert.equal(await frame.getByLabel('浏览器内核', { exact: true }).inputValue(), 'chrome', 'polling must preserve unsaved selection');
  await frame.getByRole('button', { name: '保存内核选择并关闭当前浏览器', exact: true }).click();
  await frame.locator('#state').filter({ hasText: '内核就绪' }).waitFor();
  await frame.getByLabel('网页地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}`);
  await frame.getByRole('button', { name: '打开独立浏览器', exact: true }).click();
  try {
    await frame.locator('#state').filter({ hasText: '浏览器运行中' }).waitFor({ timeout: 5000 });
  } catch (error) {
    throw Error(`${error.message}\n${await frame.locator('body').innerText()}\n${startupLogs.join('')}`);
  }
  await frame.locator('.tab').first().waitFor();
  const status = await page.evaluate(() => workDesk.plugins.invoke('ai-browser', 'browser.status', []));
  assert.equal(status.running, true);
  assert.equal(status.tabs.length, 1);
  assert.match(status.tabs[0].url, /127\.0\.0\.1/);
  const screenshots = join(root, 'plugin-dev/ai-browser/dist/verification');
  await mkdir(screenshots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await frame.locator('html').evaluate((node, theme) => { node.dataset.theme = theme; }, theme);
    for (const width of [340, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setMinimumSize(240, 300);
        window.setContentSize(width, 700);
      }, width);
      assert.equal(await frame.locator('body').evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
      const help = frame.getByRole('button', { name: 'Agent 操作与数据说明', exact: true });
      await help.focus();
      await frame.getByRole('tooltip').waitFor({ state: 'visible' });
      await page.waitForTimeout(2200);
      assert.equal(await help.evaluate(node => node === document.activeElement), true);
      await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
    }
  }
  await frame.locator('#refresh').click();
  await frame.locator('.tab button').first().waitFor();
  await frame.locator('.tab button').first().click();
  await frame.locator('.tab button:not(:disabled)').first().waitFor();
  assert.equal(await frame.locator('.tab button').first().isEnabled(), true);
  await page.locator('.shelf-app[data-plugin="html-link-fixture"]').click();
  const links = page.frameLocator('iframe.plugin-view[src^="desk-plugin://html-link-fixture/"]').locator('a');
  await links.first().waitFor();
  assert.equal(await links.first().getAttribute('title'), '在 AI 浏览器中打开');
  await links.evaluateAll(nodes => nodes.forEach(node => node.click()));
  await frame.locator('.tab').nth(2).waitFor();
  const previews = await page.evaluate(() => workDesk.plugins.invoke('ai-browser', 'browser.status', []));
  assert.equal(previews.tabs.length, 3, 'two HTML requests preserve the existing website and each other');
  assert.ok(previews.tabs.some(tab => decodeURIComponent(tab.url).endsWith('/报告 预览.html')));
  assert.ok(previews.tabs.some(tab => tab.url.endsWith('/second.htm')));
  assert.equal(await page.locator('iframe.plugin-view[src^="desk-plugin://ai-browser/"]').count(), 1);
  await frame.locator('#close').click();
  await frame.locator('#state').filter({ hasText: '浏览器未打开' }).waitFor();
  const view = page.locator('iframe.plugin-view[src^="desk-plugin://ai-browser/"]');
  await view.evaluate(node => { node.src = 'desk-plugin://ai-browser/dist/renderer/settings.html'; });
  await frame.locator('#engine').waitFor();
  assert.equal(await frame.locator('#open-form').isVisible(), false);
  assert.equal(await frame.locator('#engine-settings').isVisible(), true);
  assert.deepEqual(errors, []);
});
