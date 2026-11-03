import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, toggleTheme } from '../../../../desk/test/electron/helpers.js';

const nodes = [
  ["start", "flow.start", "01 开始 · 手动运行"],
  ["document", "text.input", "02 需求文档 · 唯一输入"],
  ["enabled", "flow.route", "03 检查需求文档"],
  ["setup", "flow.end", "待输入需求文档 · 不调用 Agent"],
  ["requirements", "agent.review", "04 产品 Agent · 需求分析"],
  ["requirementsReady", "flow.route", "05 需求是否可实施"],
  ["clarify", "flow.user-input", "补充需求 · 用户介入"],
  ["design", "agent.review", "06 开发 Agent · 方案设计 / 修订"],
  ["devArchitecture", "agent.review", "07 开发评审 A · 架构与边界"],
  ["devQuality", "agent.review", "08 开发评审 B · 实现与质量"],
  ["productReview", "agent.review", "09 产品评审 · 需求覆盖"],
  ["testReview", "agent.review", "10 测试评审 · 可验证性"],
  ["reviewRouter", "agent.review", "11 评审路由 Agent · 汇总四方意见"],
  ["designLoop", "flow.loop", "12 评审返工 · 最多 3 轮后人工决定"],
  ["designPassed", "flow.route", "13 四方通过才允许开发"],
  ["designStopped", "flow.end", "评审未通过 · 保留意见"],
  ["implementation", "agent.review", "14 开发 Agent · 代码编辑 / 编码修复"],
  ["integration", "agent.review", "15 测试 Agent · 集成测试与回归"],
  ["testsPassed", "flow.route", "16 测试通过才进入产品验收"],
  ["acceptance", "agent.review", "17 产品 Agent · 产品验收"],
  ["deliveryRouter", "agent.review", "18 交付路由 Agent · 决定修复或交付"],
  ["repairLoop", "flow.loop", "19 测试 / 验收返工 · 最多 3 轮"],
  ["deliveryPassed", "flow.route", "20 测试与验收双通过才能交付"],
  ["unfinished", "flow.end", "未验收交付 · 保留修复清单"],
  ["report", "result.collect", "21 汇总交付 · 结果与证据"],
  ["done", "flow.end", "22 完成 · 等待用户审核交付"],
  ["clarificationLoop", "flow.loop", "补充后重新分析需求"],
  ["clarificationStopped", "flow.end", "退出需求补充 · 未进入开发"]
];
const edges = [
  ["start", "document", ""],
  ["document", "enabled", ""],
  ["enabled", "setup", "false"],
  ["enabled", "requirements", "true"],
  ["requirements", "requirementsReady", ""],
  ["requirementsReady", "clarify", "false"],
  ["requirementsReady", "design", "true"],
  ["design", "devArchitecture", ""],
  ["devArchitecture", "reviewRouter", ""],
  ["design", "devQuality", ""],
  ["devQuality", "reviewRouter", ""],
  ["design", "productReview", ""],
  ["productReview", "reviewRouter", ""],
  ["design", "testReview", ""],
  ["testReview", "reviewRouter", ""],
  ["reviewRouter", "designLoop", ""],
  ["designLoop", "design", "continue"],
  ["designLoop", "designPassed", "exit"],
  ["designPassed", "implementation", "true"],
  ["designPassed", "designStopped", "false"],
  ["implementation", "integration", ""],
  ["integration", "testsPassed", ""],
  ["testsPassed", "acceptance", "true"],
  ["testsPassed", "deliveryRouter", "false"],
  ["acceptance", "deliveryRouter", ""],
  ["deliveryRouter", "repairLoop", ""],
  ["repairLoop", "implementation", "continue"],
  ["repairLoop", "deliveryPassed", "exit"],
  ["deliveryPassed", "report", "true"],
  ["deliveryPassed", "unfinished", "false"],
  ["report", "done", ""],
  ["clarify", "clarificationLoop", ""],
  ["clarificationLoop", "requirements", "continue"],
  ["clarificationLoop", "clarificationStopped", "exit"]
];

test('最新 DeskPG：研发模板自动布局、缩放和平移，保存后恢复且业务配置不变', { timeout: 120000 }, async t => {
  const { app, page, logs } = await launch(t, { executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  t.after(() => writeFile(`${output}/canvas-layout.log`, logs.join('')));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  // The latest installation already includes this plugin; verify the packaged version instead of installing twice.
  const installed = await page.evaluate(() => workDesk.plugins.list());
  assert.equal(installed.find(plugin => plugin.id === 'work-flow')?.version, manifest.version);
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '软件研发流程自动布局验证',
    nodes: nodes.map(([id, type, title], index) => ({ id, type, title, x: 20, y: 20,
      ...(index === 0 ? { width: 310, height: 180 } : {}), params: { note: `保留配置-${id}` } })),
    edges: edges.map(([from, to, branch]) => ({ from, to, ...(branch ? { branch } : {}) })) });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#auto-layout').click();
  await frame.locator('#status').filter({ hasText: '已自动布局' }).waitFor();
  const fitPercent = Number((await frame.locator('#zoom-reset').innerText()).replace('%', ''));
  assert.ok(fitPercent < 100 && fitPercent >= 5);
  const geometry = await frame.locator('#stage').evaluate(stage => ({
    nodes: [...stage.querySelectorAll('.node')].map(element => ({ id: element.dataset.node,
      x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight })),
    paths: [...stage.querySelectorAll('.edge-line')].map(element => element.getAttribute('d'))
  }));
  for (const [index, a] of geometry.nodes.entries()) {
    for (const b of geometry.nodes.slice(index + 1)) {
      assert.ok(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y),
        `${a.id} 与 ${b.id} 不重叠`);
    }
  }
  assert.equal(geometry.paths.length, 34);
  for (const path of geometry.paths) {
    const points = [...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match => ({ x: +match[1], y: +match[2] }));
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      for (const rect of geometry.nodes) {
        const horizontal = a.y === b.y && a.y > rect.y && a.y < rect.y + rect.height
          && Math.max(a.x, b.x) > rect.x && Math.min(a.x, b.x) < rect.x + rect.width;
        const vertical = a.x === b.x && a.x > rect.x && a.x < rect.x + rect.width
          && Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < rect.y + rect.height;
        assert.ok(!horizontal && !vertical, `连线不穿过 ${rect.id}`);
      }
    }
  }
  await page.screenshot({ path: `${output}/canvas-layout-overview.png` });
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  const saved = (await invoke('workflows.list')).find(item => item.id === workflow.id);
  assert.deepEqual(saved.edges, workflow.edges);
  saved.nodes.forEach((node, index) => {
    assert.deepEqual(node.params, workflow.nodes[index].params);
    assert.equal(node.width, workflow.nodes[index].width);
    assert.equal(node.height, workflow.nodes[index].height);
  });
  assert.equal(Number((await frame.locator('#zoom-reset').innerText()).replace('%', '')), fitPercent,
    '保存和重新绘制不重置缩放');
  await frame.locator('#zoom-reset').click();
  assert.equal(await frame.locator('#zoom-reset').innerText(), '100%');
  await frame.locator('#zoom-out').click();
  const scale = 1 / 1.2;
  const first = frame.locator('[data-node="start"]');
  await first.scrollIntoViewIfNeeded();
  const before = await first.boundingBox();
  const header = await first.locator('header .title').boundingBox();
  await page.mouse.move(header.x + 40, header.y + 8);
  await page.mouse.down();
  await page.mouse.move(header.x + 100, header.y + 38, { steps: 6 });
  await page.mouse.up();
  const after = await first.boundingBox();
  assert.ok(Math.abs(after.x - before.x - 60) < 2, '缩放后节点水平拖动按鼠标距离');
  assert.ok(Math.abs(after.y - before.y - 30) < 2, '缩放后节点垂直拖动按鼠标距离');
  const sizeBefore = await first.boundingBox();
  const handle = await first.getByRole('button', { name: '调整节点大小', exact: true }).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 50, handle.y + handle.height / 2 + 25, { steps: 6 });
  await page.mouse.up();
  const sizeAfter = await first.boundingBox();
  assert.ok(Math.abs(sizeAfter.width - sizeBefore.width - 50) <= scale);
  assert.ok(Math.abs(sizeAfter.height - sizeBefore.height - 25) <= scale);
  const wrap = frame.locator('#stage-wrap');
  const viewport = await wrap.boundingBox();
  const blankX = viewport.x + viewport.width - 80;
  const blankY = viewport.y + 25;
  const scrollBefore = await wrap.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
  await page.mouse.move(blankX, blankY);
  await page.mouse.down();
  await page.mouse.move(blankX - 120, blankY - 30, { steps: 5 });
  await page.mouse.up();
  const scrollAfter = await wrap.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
  assert.ok(scrollAfter.x > scrollBefore.x + 100, '空白处拖动平移画布');
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await frame.locator('#zoom-reset').filter({ hasNotText: '83%' }).waitFor();
  assert.ok(Number((await frame.locator('#zoom-reset').innerText()).replace('%', '')) > 83);
  await frame.locator('[data-node="design"]').scrollIntoViewIfNeeded();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.screenshot({ path: `${output}/canvas-layout-detail-${theme}.png` });
  await toggleTheme(page);
  await page.screenshot({ path: `${output}/canvas-layout-detail-${theme === 'dark' ? 'light' : 'dark'}.png` });
  await page.reload();
  if (!await frame.locator('#stage').isVisible()) {
    await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  }
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  assert.deepEqual(await first.evaluate(element => ({ x: element.offsetLeft, y: element.offsetTop })),
    { x: saved.nodes[0].x, y: saved.nodes[0].y });
  const restored = await first.boundingBox();
  const restoredView = await wrap.boundingBox();
  assert.ok(restored.y >= restoredView.y && restored.y + restored.height <= restoredView.y + restoredView.height,
    '重新打开时起始节点在视口内');
  assert.deepEqual(errors, []);
});
