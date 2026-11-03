import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

test('Feishu robot panel keeps secrets local, preserves drafts and uses saved configuration for tests', async t => {
  const source = await readFile(resolve('plugin-dev/work-flow/src/renderer/feishu-robot-panel.js'), 'utf8');
  const styles = await Promise.all(['desk/src/resource/controls.css', 'plugin-dev/work-flow/src/renderer/style.css']
    .map(path => readFile(resolve(path), 'utf8')));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>${styles.join('\n')}</style><details open hidden id="feishu-robot-settings">
    <summary>飞书机器人</summary><div id="feishu-robot-panel"></div></details><p id="status"></p>`);
  await page.evaluate(source => {
    const create = new Function(`${source.replace('export function', 'function')}; return createFeishuRobotPanel;`)();
    window.createPanel = create;
    window.calls = [];
    window.saved = { configured: false, hasKey: false, webhookHint: '' };
    window.failure = '';
    window.panel = create(document.querySelector('#feishu-robot-panel'), {
      setStatus(message, error) { document.querySelector('#status').textContent = message; window.statusError = error; },
      async invoke(method, input) {
        window.calls.push({ method, input });
        if (window.hold) { await new Promise(resolve => { window.release = resolve; }); }
        if (window.failure === method) { throw new Error('fixture failure'); }
        if (method === 'robots.feishu.save') {
          window.saved = { configured: true, hasKey: true, webhookHint: '…fixture' };
        }
        return method === 'robots.feishu.test' ? { sentParts: 1, totalParts: 1 } : window.saved;
      }
    });
    window.panel.show(true);
  }, source);
  const webhook = page.getByLabel('Webhook', { exact: true });
  const key = page.getByLabel('签名密钥', { exact: true });
  const save = page.getByRole('button', { name: '保存飞书机器人', exact: true });
  const send = page.getByRole('button', { name: '发送飞书测试通知', exact: true });
  await page.waitForFunction(() => window.calls.length === 1 && !document.querySelector('#feishu-robot-webhook').disabled);
  assert.equal(await webhook.getAttribute('type'), 'password');
  assert.equal(await key.getAttribute('type'), 'password');
  assert.equal(await webhook.inputValue(), '');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.locator('form').count(), 0);
  await webhook.fill('fixture-webhook');
  await key.fill('fixture-key');
  await page.evaluate(() => { window.panel.show(false); window.panel.show(true); });
  assert.equal(await webhook.inputValue(), 'fixture-webhook');
  await page.evaluate(() => { window.failure = 'robots.feishu.save'; });
  await save.click();
  await page.waitForFunction(() => window.statusError === true);
  assert.equal(await webhook.inputValue(), 'fixture-webhook');
  await page.evaluate(() => { window.failure = ''; window.hold = true; });
  await save.click();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await send.isDisabled(), true);
  assert.equal(await webhook.isDisabled(), true);
  await page.evaluate(() => { window.hold = false; window.release(); });
  await page.waitForFunction(() => document.querySelector('#feishu-robot-webhook').value === '');
  assert.deepEqual((await page.evaluate(() => window.calls.at(-1))).input,
    { webhook: 'fixture-webhook', key: 'fixture-key' });
  assert.equal(await key.inputValue(), '');
  assert.match(await page.locator('#feishu-robot-panel').innerText(), /已配置.*fixture/s);
  await key.fill('new-fixture-key');
  assert.equal(await send.isDisabled(), true);
  await save.click();
  await page.waitForFunction(() => document.querySelector('#feishu-robot-key').value === '');
  assert.deepEqual((await page.evaluate(() => window.calls.at(-1))).input, { webhook: '', key: 'new-fixture-key' });
  await send.click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('1/1'));
  assert.equal((await page.evaluate(() => window.calls.at(-1))).input, undefined);
  await page.evaluate(() => { window.failure = 'robots.feishu.test'; });
  await send.click();
  await page.waitForFunction(() => window.statusError === true);
  assert.equal(await send.isEnabled(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /fixture-webhook|fixture-key|new-fixture-key/);

  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 900]) {
      await page.setViewportSize({ width, height: 640 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await webhook.focus();
      await page.keyboard.press('Tab');
      assert.equal(await key.evaluate(node => node === document.activeElement), true);
      const help = page.getByRole('button', { name: '飞书机器人配置说明', exact: true });
      await help.focus();
      assert.equal(await page.getByRole('tooltip').isVisible(), true);
      const tooltipBounds = await page.getByRole('tooltip').boundingBox();
      assert.ok(tooltipBounds.x >= 0 && tooltipBounds.x + tooltipBounds.width <= width);
      await page.screenshot({ path: resolve(output, `feishu-robot-${theme}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const bounds = await send.boundingBox();
      assert.ok(bounds.x + bounds.width <= width);
      assert.equal(await webhook.evaluate(node => getComputedStyle(node).backgroundColor),
        theme === 'light' ? 'rgb(247, 247, 247)' : 'rgb(24, 24, 24)');
    }
  }
  await page.evaluate(() => {
    window.failure = 'robots.feishu.read';
    window.statusError = false;
    window.panel = window.createPanel(document.querySelector('#feishu-robot-panel'), {
      setStatus(message, error) { document.querySelector('#status').textContent = message; window.statusError = error; },
      async invoke() {
        if (window.failure) { throw new Error('fixture-webhook'); }
        return window.saved;
      }
    });
    window.panel.show(true);
  });
  await page.waitForFunction(() => window.statusError === true);
  assert.equal(await save.isDisabled(), true);
  assert.doesNotMatch(await page.locator('#status').innerText(), /fixture-webhook/);
  await page.evaluate(() => { window.failure = ''; window.panel.show(false); window.panel.show(true); });
  await page.waitForFunction(() => !document.querySelector('#feishu-robot-save').disabled);
  assert.equal(await webhook.inputValue(), '');
  assert.equal(await key.inputValue(), '');
  assert.deepEqual(errors, []);
});
