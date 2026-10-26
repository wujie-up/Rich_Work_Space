import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('service selection preserves card and neighbouring layout in both themes', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<main><div class="layout"><nav id="services">
    <button>线上数据库查询 · Metabase<br><small>running · 0 个连接</small></button>
    <button>SLS 日志查询 · prod<br><small>running · 0 个连接</small></button>
    <button>添加服务</button></nav><section id="details">配置</section></div></main>`);
  await page.addStyleTag({ content: await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8') });
  for (const theme of ['light', 'dark']) {
    await page.locator('html').evaluate((element, theme) => { element.dataset.theme = theme; }, theme);
    // Sweep wrapping boundaries: selecting a card must never change text metrics or displace its neighbours.
    for (const width of [600, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      const cards = page.locator('#services button');
      await cards.evaluateAll(elements => elements.forEach(element => element.classList.remove('selected')));
      const geometry = () => page.locator('#services button, #details').evaluateAll(elements => elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }));
      const baseline = await geometry();
      for (const card of await cards.all()) {
        await cards.evaluateAll(elements => elements.forEach(element => element.classList.remove('selected')));
        await card.evaluate(element => element.classList.add('selected'));
        assert.deepEqual(await geometry(), baseline, `${theme}, viewport ${width}: selection moved the layout`);
      }
    }
  }
});
