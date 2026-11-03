import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatReviewSections } from '../../../plugin-dev/work-flow/src/shared/review-sections.js';

test('review popup presents ordered cards, folds evidence and retains choice delivery in both themes', { timeout: 60000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'desk-review-layout-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [resolve('desk/test/fixtures/desktop-ui/main.cjs'), `--test-data=${data}`], env });
  t.after(async () => { await app.close(); await rm(data, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.locator('.shelf-app').first().waitFor();
  const prompt = '第2轮评审已结束，请审核结论。\n汇总：本轮尚未通过。先确认需求基线，再由研发修订设计。\n'
    + '待确认：' + JSON.stringify(['P2 | 确定交付分期 | Q-002：US07～US10 本期交付还是延期？请逐项明确验收组。',
      'P0 | 确认需求基线 | Q-001：提供同版需求、原型及变更记录；或指定经需求负责人确认的完整替代基线。']) + '\n'
    + '问题：' + JSON.stringify(['P1 | 补齐接口契约 | I-002：明确字段类型、必填项、空值、版本冲突及错误响应。',
      'P0 | 补齐需求与设计对应关系 | I-001：按稳定需求编号逐项列出设计位置及验收依据，原需求保持只读。']) + '\n'
    + '产品审核 · 需求覆盖：' + JSON.stringify({ passed: false, summary: '缺少完整需求基线。', questions: [], issues: ['补齐原型'] });
  const request = { id: 'review-layout', pluginId: 'work-flow', title: '需求与研发设计 · 多 Agent 联合审核 · 第 1 / 1 题',
    question: prompt, sections: formatReviewSections(prompt, prompt), placement: 'center', required: true,
    optionsOnly: true, options: ['确认结论，继续流程', '提出修改意见，重新评审', '结束审核，保留分歧'] };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(({ theme, request }) => {
      localStorage.setItem('test-preferences', JSON.stringify({ theme, gridSize: 24 }));
      localStorage.setItem('test-messages', JSON.stringify([request]));
    }, { theme, request });
    await page.reload();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.plugin-message-section > h3').allTextContents(),
      ['本轮结论', '需要你确认', '阻断与高优先级问题']);
    const decisions = dialog.locator('section').filter({ has: page.getByRole('heading', { name: '需要你确认', exact: true }) });
    assert.deepEqual(await decisions.locator('h4').allTextContents(), ['确认需求基线', '确定交付分期']);
    assert.deepEqual(await decisions.locator('.plugin-message-priority').allTextContents(), ['P0', 'P2']);
    assert.match(await decisions.locator('p').first().textContent(), /^Q-001/);
    assert.equal(await dialog.locator('details[open]').count(), 0);
    assert.equal(await dialog.getByText('"passed"', { exact: false }).isVisible(), false);
    assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true);
    const box = await dialog.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2);
    assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2);
    await dialog.screenshot({ path: `.test-results/review-cards-${theme}.png` });
    const evidence = dialog.locator('details').first();
    await evidence.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await evidence.getAttribute('open'), '');
    await evidence.locator('summary').press('Enter');
    if (theme === 'dark') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 720));
      await dialog.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth));
      assert.ok(await dialog.locator('.dialog-body').evaluate(node => node.scrollWidth <= node.clientWidth));
      await dialog.screenshot({ path: '.test-results/review-cards-narrow.png' });
    }
    await dialog.getByRole('button', { name: request.options[1], exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('test-message-answer'))),
      { id: request.id, answer: { text: request.options[1] } });
  }
});
