import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('web access settings omit absent errors and display real errors', async () => {
  const bundle = await build({ stdin: {
    contents: "import { mountWebSettings } from './web/src/browser/settings.js'; window.mountWebSettings = mountWebSettings;",
    resolveDir: process.cwd()
  }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html lang="zh-CN"><body></body></html>');
    await page.evaluate(() => {
      window.workDesk = { web: {
        status: async () => ({ port: 47831, enabled: false, certificatePath: '/test/certificate.pem', addresses: [], error: window.testError }),
        listAccounts: async () => []
      } };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const error of [null, '端口被占用']) {
      const result = await page.evaluate(async error => {
        document.body.replaceChildren();
        window.testError = error;
        await window.mountWebSettings(document.body);
        document.querySelector('[aria-label="网页访问设置"]').click();
        return { text: document.body.textContent, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) };
      }, error);
      assert.equal(result.text.includes('null'), false);
      assert.deepEqual(result.alerts, error ? [error] : []);
    }
  } finally {
    await browser.close();
  }
});
