import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { temporaryStore } from '../../../../desk/test/helpers.js';
import { activate, deactivate } from '../../src/main/common/index.js';
import { PluginRuntime } from '../../../../desk/src/main/common/plugin-runtime.js';

test('定时图标与运行图标独立、立即触发保留排期，支持明暗主题、窄窗口与键盘', { timeout: 60000 }, async t => {
  const storage = await temporaryStore(t);
  const methods = new Map();
  let page;
  const errors = [];
  const pendingEvents = new Set();
  const eventBridge = { id: 'work-flow', emit: (channel, value) => {
    if (!page) { return; }
    const event = page.evaluate(({ channel, value }) => window.fixtureEvents?.[channel]?.(value), { channel, value });
    pendingEvents.add(event);
    event.finally(() => pendingEvents.delete(event)).catch(error => errors.push(error.message));
  } };
  await activate({ pluginId: 'work-flow', storage, ownProcesses: () => {},
    capabilities: { discover: async () => ({ providers: [] }) },
    // Exercise the real host event envelope, including its pluginId injection.
    emit: (channel, value) => PluginRuntime.prototype.receive.call(eventBridge, { type: 'event', channel, value }),
    methods: { register: (name, handler) => methods.set(name, handler) },
    services: { register: () => {} }, lifecycle: { register: () => {} }, views: { register: () => {} } });
  const invoke = (method, ...args) => methods.get(method)(...args);
  const workflow = await invoke('workflows.save', { name: '定时测试', nodes: [
    { id: 'start', type: 'flow.start', title: '开始', params: {} },
    { id: 'human', type: 'flow.user-input', title: '测试确认', params: { prompt: '检查定时执行' } },
    { id: 'end', type: 'flow.end', title: '结束', params: {} }],
  edges: [{ from: 'start', to: 'human' }, { from: 'human', to: 'end' }],
  trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: true } });
  let due = (await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt;
  const bundle = await build({ entryPoints: ['plugin-dev/work-flow/src/renderer/app.js'], bundle: true,
    write: false, outdir: '.test-results/work-flow/fixture', format: 'esm', platform: 'browser',
    plugins: [{ name: 'fixture-api', setup(build) {
      build.onLoad({ filter: /desk\/src\/resource\/plugin-host\.js$/ }, () => ({ contents:
        'export const pluginHostOrigin = () => location.origin; export const pluginIdentity = () => "work-flow";' }));
      build.onLoad({ filter: /work-flow\/src\/renderer\/api\.js$/ }, () => ({ contents: `
        export const invoke = (method, ...args) => window.fixtureInvoke(method, ...args);
        export const subscribe = channel => callback => { window.fixtureEvents[channel] = callback; };
        export const preferences = async () => ({ theme: 'light' });
        export const chooseFile = async () => null;
        export const chooseDirectory = async () => null;
        export const chooseDesktopFile = async () => null;
        export const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      ` }));
    } }] });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await deactivate();
    await Promise.allSettled([...pendingEvents]);
    page = null;
    await browser.close();
  });
  page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await mkdir('.test-results/work-flow', { recursive: true });
  await writeFile('.test-results/work-flow/scheduled-fixture.js', bundle.outputFiles.find(file => file.path.endsWith('.js')).text);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fixtureInvoke', invoke);
  // Give sessionStorage a real origin; no installed application or user data is involved.
  await page.route('http://workflow.test/**', route => route.fulfill({ body: '<div id="app"></div>', contentType: 'text/html' }));
  await page.goto('http://workflow.test/');
  await page.evaluate(id => { window.fixtureEvents = {}; sessionStorage.setItem('work-flow.current', id); }, workflow.id);
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  const item = page.locator(`[data-workflow="${workflow.id}"]`);
  await item.waitFor({ timeout: 5000 }).catch(error => { throw Error(`${error.message}; browser errors: ${errors.join('; ')}`); });
  await invoke('workflows.save', workflow);
  await Promise.allSettled([...pendingEvents]);
  assert.deepEqual(errors, []);
  await page.locator('#workflow-properties details').first().evaluate(node => { node.open = true; });
  assert.equal(await page.locator('#trigger-help').isVisible(), false, '次要说明只在悬停或聚焦帮助按钮时显示');
  assert.equal(await item.locator('.workflow-schedule').count(), 1);
  assert.equal(await item.locator('.workflow-activity').count(), 0);
  assert.equal(await page.locator('#run').getAttribute('aria-label'), '关闭定时');
  assert.equal(await page.locator('#run').getAttribute('aria-pressed'), 'true');
  await page.locator('#run').click();
  await page.locator('#status-text').filter({ hasText: '定时已关闭' }).waitFor();
  assert.equal((await invoke('runs.list', workflow.id)).length, 0);
  assert.equal((await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt, null);
  assert.equal(await page.locator('#run').getAttribute('aria-label'), '开启定时');
  assert.equal(await page.locator('#run').getAttribute('title'), '开启定时');
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#trigger-enabled')?.checked === true
    && document.querySelector('#status-text').textContent.includes('定时已开启'));
  assert.equal((await invoke('runs.list', workflow.id)).length, 0);
  due = (await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt;
  const fire = page.getByRole('button', { name: '立即触发', exact: true });
  assert.equal(await fire.getAttribute('title'), '立即触发');
  assert.equal((await fire.innerText()).trim(), '');
  assert.equal(await fire.locator('svg[aria-hidden="true"]').count(), 1);
  await fire.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#trigger-now')?.disabled === true);
  await Promise.allSettled([...pendingEvents]);
  assert.deepEqual(errors, []);
  assert.equal(await item.locator('.workflow-schedule').count(), 1);
  assert.equal(await item.locator('.workflow-activity').count(), 1);
  assert.equal((await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt, due);
  assert.equal(await page.locator('#run').isEnabled(), true, '运行期间也能关闭后续定时');
  await page.locator('#workflow-name').fill('未保存的名称');
  await page.locator('#run').click();
  await page.locator('#status-text').filter({ hasText: '定时已关闭' }).waitFor();
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).name, workflow.name,
    '关闭定时不保存画布草稿');
  assert.equal(await page.locator('#workflow-name').inputValue(), '未保存的名称');
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#run').getAttribute('aria-pressed') === 'true');
  const row = (await invoke('triggers.next')).find(row => row.workflowId === workflow.id);
  await invoke('runs.cancel', row.lastRunId);
  await page.waitForFunction(() => document.querySelector('#trigger-now')?.disabled === false);
  // Moving focus out of this manual-input fixture may defer it before cancellation reaches the engine.
  assert.ok(['canceled', 'interrupted'].includes((await invoke('runs.get', row.lastRunId)).status));
  await page.locator('#triggers').getByText(/最近执行/).waitFor();
  for (let index = 0; index < 3; index += 1) {
    const run = await invoke('triggers.fire', workflow.id);
    await page.waitForFunction(async id => (await window.fixtureInvoke('runs.get', id)).status === 'waiting', run.id);
    await invoke('runs.cancel', run.id);
  }
  await page.waitForFunction(() => document.querySelectorAll('.run-history-row').length === 4);
  assert.equal(await page.locator('.run-history .result-item').count(), 0);
  const historyRows = page.locator('.run-history-row');
  const times = await historyRows.evaluateAll(rows => rows.map(row => Number(row.dataset.startedAt)));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  await mkdir('.test-results/work-flow', { recursive: true });
  for (const theme of ['light', 'dark']) {
    for (const width of [900, 440]) {
      await page.setViewportSize({ width, height: 720 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await fire.focus();
      assert.equal(await fire.evaluate(node => document.activeElement === node), true);
      const box = await fire.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      for (const row of await historyRows.all()) {
        const bounds = await row.boundingBox();
        assert.ok(bounds.height <= 42, '每次执行只占一行');
        assert.equal(await row.locator('.run-history-time').evaluate(node => node.scrollWidth <= node.clientWidth), true,
          '窄窗口仍完整显示执行时间');
        assert.equal(await row.locator('[data-history-run]').count(), 1);
        const actions = await row.locator('.run-history-actions').boundingBox();
        assert.ok(actions.x + actions.width >= bounds.x + bounds.width - 2, '记录操作靠右排列');
      }
      assert.equal(await item.locator('.workflow-schedule').count(), 1);
      await historyRows.last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.test-results/work-flow/scheduled-${theme}-${width}.png` });
    }
  }
  await invoke('workflows.save', { ...workflow, trigger: { ...workflow.trigger, enabled: false } });
  await page.waitForFunction(id => !document.querySelector(`[data-workflow="${id}"] .workflow-schedule`), workflow.id);
  await page.locator('#run').click();
  await page.locator('#status-text').filter({ hasText: '定时已开启' }).waitFor();
  assert.equal((await invoke('triggers.next')).find(row => row.workflowId === workflow.id).enabled, true,
    '其他窗口关闭定时后，当前窗口开启必须真正持久化');
  // Match the reported sequence: enable a saved schedule and immediately run it once.
  await invoke('workflows.save', workflow);
  await page.waitForFunction(id => Boolean(document.querySelector(`[data-workflow="${id}"] .workflow-schedule`)), workflow.id);
  await fire.click();
  await page.waitForFunction(() => document.querySelector('#trigger-now')?.disabled === true);
  assert.equal(await item.locator('.workflow-schedule').count(), 1);
  assert.equal(await item.locator('.workflow-activity').count(), 1);
  assert.deepEqual(errors, []);
  const active = (await invoke('runs.activity')).find(run => run.workflowId === workflow.id);
  await invoke('runs.cancel', active.id);
  await page.locator('#trigger-mode').selectOption('manual');
  const beforeManual = (await invoke('runs.list', workflow.id)).length;
  await page.locator('#run').click();
  await page.waitForFunction(() => !document.querySelector('#cancel-run').disabled);
  assert.equal((await invoke('runs.list', workflow.id)).length, beforeManual + 1, '仅手动模式的运行仍执行一次');
  assert.equal(await page.locator('#trigger-now').isVisible(), false);
  assert.equal(await page.locator('#run').getAttribute('aria-label'), '运行');
  await page.waitForFunction(() => document.querySelectorAll('.run-history-row').length === 5);
  await writeFile(resolve('.test-results/work-flow/scheduled-ui-result.json'), JSON.stringify({ due, themes: ['light', 'dark'], widths: [900, 440] }));
});
