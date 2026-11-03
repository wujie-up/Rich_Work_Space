import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Storage } from '../../../../desk/src/main/common/storage.js';
import { Workflows } from '../../src/main/common/workflows.js';

test('daily trigger: Chromium preserves Beijing time with shared controls in both themes and narrow windows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-daily-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflows = new Workflows({ storage: new Storage(root), pluginId: 'work-flow' });
  const source = await readFile(resolve('plugin-dev/work-flow/src/renderer/app.js'), 'utf8');
  const styles = await Promise.all(['desk/src/resource/controls.css', 'plugin-dev/work-flow/src/renderer/style.css']
    .map(path => readFile(resolve(path), 'utf8')));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('saveFixture', value => workflows.save(value));
  await page.exposeFunction('readFixture', id => workflows.read(id));
  // Inline the same CSS imports in their application order; no plugin or production bundle is started.
  await page.setContent(`<style>${styles.join('\n')}</style>
    <aside class="inspector"><details open><summary>运行方式</summary><div id="triggers"></div></details></aside>`);
  await page.evaluate(({ labels, renderer }) => {
    const state = { dirty: false, connections: [], triggers: [], triggerOptions: { modes: [], units: [] } };
    let workflow;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const render = new Function('state', 'current', 'escape', 'renderStatus', `${labels}\n${renderer}\nreturn renderTriggers;`)
      (state, () => workflow, escape, () => {});
    window.fixture = {
      reset() {
        workflow = { name: 'Daily fixture', nodes: [{ id: 'a', type: 'text.input', params: { content: 'fixture' } }],
          edges: [], trigger: { mode: 'manual', enabled: false } };
        render();
      },
      async saveAndReopen() {
        const saved = await window.saveFixture(workflow);
        workflow = await window.readFixture(saved.id);
        render();
        return workflow.trigger;
      }
    };
    window.fixture.reset();
  }, { labels: source.match(/const MODE_LABELS = [^\n]+/)[0],
    renderer: source.slice(source.indexOf('function renderTriggers()'), source.indexOf('function paramHtml(')) });

  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 900]) {
      await page.setViewportSize({ width, height: 640 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.fixture.reset(); }, theme);
      const mode = page.locator('#trigger-mode');
      const time = page.locator('#trigger-at');
      const enabled = page.locator('#trigger-enabled');
      assert.equal(await mode.locator('option[value="daily"]').textContent(), '每日固定时间（北京时间）');
      await mode.selectOption('daily');
      assert.equal(await time.getAttribute('type'), 'time');
      assert.equal(await time.inputValue(), '10:00');
      assert.equal(await enabled.isChecked(), true);
      assert.deepEqual(await page.evaluate(() => window.fixture.saveAndReopen()),
        { mode: 'daily', at: '10:00', timezone: 'Asia/Shanghai', enabled: true });
      assert.equal(await time.inputValue(), '10:00');
      assert.equal(await mode.inputValue(), 'daily');

      await mode.focus();
      await page.keyboard.press('Tab');
      assert.equal(await time.evaluate(node => document.activeElement === node), true);
      assert.equal(await time.evaluate(node => getComputedStyle(node).borderColor), theme === 'light' ? 'rgb(68, 68, 68)' : 'rgb(173, 176, 183)');
      await time.fill('09:45');
      await time.press('Tab');
      await enabled.focus();
      await page.keyboard.press('Space');
      assert.equal(await enabled.isChecked(), false);
      assert.deepEqual(await page.evaluate(() => window.fixture.saveAndReopen()),
        { mode: 'daily', at: '09:45', timezone: 'Asia/Shanghai', enabled: false });
      assert.equal(await time.inputValue(), '09:45');
      // Daily mode intentionally keeps time editable while disabled, so users can prepare the next schedule.
      assert.equal(await time.isEnabled(), true);
      await enabled.focus();
      await page.keyboard.press('Space');
      assert.equal((await page.evaluate(() => window.fixture.saveAndReopen())).enabled, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
        `${theme}/${width}: no horizontal overflow`);
      for (const control of [mode, time, enabled]) {
        const bounds = await control.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${theme}/${width}: control stays visible`);
      }
      assert.equal(await time.evaluate(node => getComputedStyle(node).backgroundColor),
        theme === 'light' ? 'rgb(247, 247, 247)' : 'rgb(24, 24, 24)');
      await page.screenshot({ path: join(output, `daily-trigger-${theme}-${width}.png`) });
    }
  }
  assert.deepEqual(errors, []);
});
