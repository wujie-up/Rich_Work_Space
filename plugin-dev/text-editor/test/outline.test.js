import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()}: touch outline expires without selecting a heading; mouse and keyboard keep it open`, async t => {
    const browser = await browserType.launch({ headless: true });
    t.after(() => browser.close());
    const bundle = await build({ entryPoints: [new URL('../src/renderer/outline.js', import.meta.url).pathname],
      bundle: true, write: false, format: 'iife', globalName: 'Outline' });
    const css = await readFile(new URL('../src/renderer/app.css', import.meta.url), 'utf8');
    for (const hasTouch of [true, false]) {
      const context = await browser.newContext({ hasTouch, viewport: { width: hasTouch ? 390 : 1100, height: 700 } });
      const page = await context.newPage();
      await page.setContent(`<main><div id="panes" data-mode="read" style="position:relative">
        <textarea id="editor"># Overview\n\n## Details</textarea><div id="preview"><h1>Overview</h1><h2>Details</h2></div>
        <div id="outline-zone" tabindex="0" hidden><nav id="outline"></nav></div></div></main>`);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() => Outline.setupOutline(document.querySelector('#panes'))({ id: 'touch-document', type: 'md' }));
      const zone = page.locator('#outline-zone');
      const outline = page.locator('#outline');
      await outline.locator('button').first().waitFor();
      if (hasTouch) {
        await zone.tap({ position: { x: 20, y: 100 } });
        // iOS can retain a touch hover without a matching pointerleave until the next tap.
        await zone.dispatchEvent('pointerenter', { pointerType: 'touch' });
        await page.waitForTimeout(4500);
        assert.equal(await outline.evaluate(element => getComputedStyle(element).visibility), 'hidden');
        await zone.tap({ position: { x: 20, y: 100 } });
        assert.equal(await zone.getAttribute('data-visible'), 'true', 'touch must reopen the outline');
      } else {
        await zone.hover();
        await page.waitForTimeout(4500);
        assert.equal(await outline.evaluate(element => getComputedStyle(element).opacity), '1');
        await page.locator('#preview').hover({ position: { x: 10, y: 500 } });
        await zone.focus();
        await page.keyboard.press(browserType === webkit ? 'Alt+Tab' : 'Tab');
        assert.equal(await outline.locator('button').first().evaluate(element => element === document.activeElement), true);
        await page.waitForTimeout(4500);
        assert.equal(await outline.evaluate(element => getComputedStyle(element).opacity), '1');
      }
      await context.close();
    }
  });
}
