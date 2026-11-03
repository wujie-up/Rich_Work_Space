import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openConfiguration, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('工作流简洁节点、悬停卡片、折叠结果与节点连接配置', { timeout: 120000 }, async t => {
  const { app, page, logs } = await launch(t, { executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    openPlugin: false, prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  t.after(() => writeFile(`${output}/route-shape.log`, logs.join('')));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve(`plugin-dev/dist/work-flow-${manifest.version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '条件路由菱形验证', nodes: [
    { id: 'source', type: 'text.input', title: '评审结果', x: 30, y: 30, params: { content: 'true', format: 'json' } },
    { id: 'route', type: 'flow.route', title: '多角色方案评审是否通过并进入后续编码阶段', x: 290, y: 30, params: { input: '{{source.value}}', expected: 'true' } },
    { id: 'done', type: 'flow.end', title: '完成', x: 590, y: 30, params: {} }
  ], edges: [{ from: 'source', to: 'route' }, { from: 'route', to: 'done', branch: 'true' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  const route = frame.locator('[data-node="route"]');
  const handle = route.getByRole('button', { name: '调整节点大小', exact: true });

  async function checkGeometry() {
    const geometry = await route.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const corners = selector => {
        const box = element.querySelector(selector).getBoundingClientRect();
        return [box.left, box.right].flatMap(x => [box.top, box.bottom].map(y =>
          Math.abs((x - bounds.left) / bounds.width * 2 - 1) + Math.abs((y - bounds.top) / bounds.height * 2 - 1)));
      };
      const port = element.querySelector('.port.out').getBoundingClientRect();
      return { labels: [...corners('header'), ...corners('.run-state')],
        portY: port.y + port.height / 2, centerY: bounds.y + bounds.height / 2 };
    });
    assert.ok(geometry.labels.every(distance => distance < 1), '标签区域完整位于菱形内部');
    assert.ok(Math.abs(geometry.portY - geometry.centerY) < 1, '端口位于菱形右侧顶点');
  }

  await checkGeometry();
  const titleLayout = await route.locator('.title').evaluate(element => ({ height: element.offsetHeight,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight), width: element.clientWidth, scrollWidth: element.scrollWidth }));
  assert.ok(titleLayout.height > titleLayout.lineHeight * 2, '长名称自动换行');
  assert.equal(titleLayout.width, titleLayout.scrollWidth, '长名称无横向截断');
  const remove = await route.getByRole('button', { name: '删除节点', exact: true }).boundingBox();
  const title = await route.locator('.title').boundingBox();
  assert.ok(remove.y + remove.height < title.y, '删除按钮与标题分离');
  assert.equal(await route.locator('.summary, .badge, .tag').count(), 0, '节点只保留名称和状态');
  await route.locator('header').hover();
  const preview = frame.locator('#node-preview');
  await preview.waitFor({ state: 'visible' });
  assert.equal(await preview.locator('h3').textContent(), '多角色方案评审是否通过并进入后续编码阶段');
  assert.equal(await preview.locator('dt').allTextContents().then(labels => labels.join(',')), '基础能力,功能分类,输入输出,执行状态,能力说明');
  await page.screenshot({ path: `${output}/node-preview.png` });
  await route.press('Escape');
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('.canvas-area > .toolbar').count(), 1, '新增与布局合并为一行');
  await frame.locator('#canvas-tools #add-node').waitFor();
  await frame.locator('#canvas-tools #auto-layout').waitFor();
  await frame.locator('#workflow-properties').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#results details[data-result-node]').count(), 3, '尚未运行时也列出所有节点');
  assert.equal(await frame.locator('#results details[data-result-node][open]').count(), 0);
  assert.equal(await frame.locator('#message-connections').isVisible(), false);
  assert.equal(await frame.locator('#mail-credentials').isVisible(), false);
  await route.screenshot({ path: `${output}/route-diamond-minimum.png` });
  await route.locator('header').click();
  await frame.locator('aside.inspector').getByText('条件路由', { exact: true }).first().waitFor();
  const outgoing = frame.locator('.edges path.hit[data-edge="route>done"]');
  const edge = await outgoing.getAttribute('d');
  const initial = await route.boundingBox();
  await handle.focus();
  await handle.press('Shift+ArrowRight');
  await handle.press('Shift+ArrowDown');
  const resized = await route.boundingBox();
  assert.equal(resized.width, initial.width + 50);
  assert.equal(resized.height, initial.height + 50);
  assert.notEqual(await outgoing.getAttribute('d'), edge);
  await checkGeometry();
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).nodes.find(node => node.id === 'route').width, resized.width);
  await page.screenshot({ path: `${output}/route-diamond-dark.png` });
  await toggleTheme(page);
  await checkGeometry();
  await page.screenshot({ path: `${output}/route-diamond-light.png` });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
  await checkGeometry();
  await page.screenshot({ path: `${output}/route-diamond-narrow.png` });
  await frame.locator('#zoom-reset').click();
  await frame.locator('[data-node="done"] header').click();
  await frame.locator('#properties .panel-title').filter({ hasText: '终止' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('[data-node="done"] .run-state').filter({ hasText: '已完成' }).waitFor();
  const results = frame.locator('#results');
  assert.equal(await results.locator('details[data-result-node]').count(), 3);
  assert.equal(await results.locator('details[data-result-node][open]').count(), 0);
  await results.locator('[data-result-node="source"] summary').click();
  await results.locator('[data-result-node="source"] pre').filter({ hasText: 'true' }).waitFor({ state: 'visible' });
  assert.equal(await results.locator('details[data-result-node][open]').count(), 1);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await results.locator('[data-result-node="source"]').getAttribute('open'), '', '重绘保留当前展开项');

  const configured = await invoke('workflows.save', { name: '节点连接配置验证', nodes: [
    { id: 'mail', type: 'mail.fetch', title: '邮件告警', x: 30, y: 30, params: {} },
    { id: 'wechat', type: 'message.wechat', title: '微信接收', x: 290, y: 30, params: {} }
  ], edges: [] });
  const feishuWorkflow = await invoke('workflows.save', { name: '飞书节点配置验证', nodes: [
    { id: 'feishu', type: 'message.feishu', title: '飞书接收', x: 30, y: 30, params: {} }
  ], edges: [] });
  // Reload through the public plugin view to fetch the newly saved workflow.
  await page.locator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]').evaluate(element => { element.src = element.src; });
  await frame.locator(`[data-workflow="${configured.id}"]`).click();
  await frame.locator('[data-node="mail"] header').click();
  await frame.locator('#mail-credentials summary').click();
  const account = frame.locator('#credentials');
  await account.locator('[data-credential="name"]').fill('本地配置验证');
  await account.locator('[data-credential="host"]').fill('imap.example.test');
  await account.locator('[data-credential="username"]').fill('workflow@example.test');
  await account.locator('[data-credential="password"]').fill('test-only-not-a-secret');
  await account.getByRole('button', { name: '保存账号', exact: true }).click();
  await frame.locator('[data-param="credentialId"] option').filter({ hasText: '本地配置验证' }).waitFor({ state: 'attached' });
  assert.equal(await frame.locator('#workflow-properties').isVisible(), false);
  assert.equal(await frame.locator('#message-connections').isVisible(), false);
  await frame.locator('[data-node="wechat"] header').click();
  await frame.locator('#message-connections summary').click();
  await frame.getByRole('button', { name: '新增消息连接', exact: true }).click();
  assert.equal(await frame.locator('#message-channel').inputValue(), 'wechat');
  assert.equal(await frame.locator('#message-channel').isDisabled(), true);
  await frame.locator('#message-name').fill('未完成的微信配置');
  await frame.locator(`[data-workflow="${feishuWorkflow.id}"]`).click();
  await frame.locator('[data-node="feishu"] header').click();
  assert.equal(await frame.locator('#mail-credentials').isVisible(), false);
  assert.equal(await frame.locator('#message-form form').count(), 0, '切换渠道不保留另一个渠道的表单');
  await frame.getByRole('button', { name: '新增消息连接', exact: true }).click();
  assert.equal(await frame.locator('#message-channel').inputValue(), 'feishu');
  await frame.locator('#message-appId').waitFor();
  await page.screenshot({ path: `${output}/node-connection-settings.png` });
  await frame.locator('#stage-wrap').click({ position: { x: 5, y: 300 } });
  await frame.locator('#workflow-properties').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#message-connections').isVisible(), false);
  assert.equal(await frame.locator('#mail-credentials').isVisible(), false);
  await page.screenshot({ path: `${output}/compact-results.png` });
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  await page.locator('dialog.plugin-settings').getByText(`v${manifest.version}`, { exact: false }).waitFor();
  assert.deepEqual(errors, []);
});
