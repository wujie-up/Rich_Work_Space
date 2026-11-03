import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuReportCards } from '../src/main/common/feishu-report.js';

const header = '| 老系统申请单ID | 申请时间 | 渠道订单号 |\n| --- | --- | --- |\n';
const row = i => `| ${9007199254740993n + BigInt(i)} | 2026-11-03 10:00:00 | M\\|&lt;at id=all&gt;\\*\\* |\n`;

test('report cards render actual tables with only three columns and literal channel order text', () => {
  const cards = buildFeishuReportCards('# 放款未回调订单巡检\n\n结果：完整\n\n## 渠道：pandapay 国家：阿根廷（AR）\n\n' + header + row(0));
  assert.equal(cards.length, 1);
  const table = cards[0].body.elements.find(e => e.tag === 'table');
  assert.deepEqual(table.columns.map(c => c.display_name), ['老系统申请单ID', '申请时间', '渠道订单号']);
  assert.ok(table.columns.every(c => c.data_type === 'text'));
  assert.equal(table.rows[0].c0, '9007199254740993');
  assert.equal(table.rows[0].c2, 'M|<at id=all>**');
  assert.equal(cards[0].schema, '2.0');
  assert.ok(cards[0].body.elements.some(element => element.tag === 'markdown'
    && element.content === '## 渠道：pandapay 国家：阿根廷（AR）'));
});

test('long reports preserve every row, repeat group headings and fit bot and table limits', () => {
  const input = '# 放款未回调订单巡检\n\n结果：完整\n\n## 渠道：pandapay 国家：阿根廷（AR）\n\n' + header
    + Array.from({ length: 127 }, (_, i) => row(i)).join('');
  const cards = buildFeishuReportCards(input);
  const tables = cards.flatMap(card => card.body.elements.filter(e => e.tag === 'table'));
  assert.equal(tables.flatMap(t => t.rows).length, 127);
  assert.equal(new Set(tables.flatMap(t => t.rows.map(r => r.c0))).size, 127);
  for (const table of tables) {
    assert.ok(table.rows.length <= 10);
    assert.equal(table.page_size, 10);
  }
  for (const card of cards) {
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 16000);
    assert.ok(card.body.elements.filter(e => e.tag === 'table').length <= 5);
    assert.match(JSON.stringify(card), /渠道：pandapay 国家：阿根廷（AR）/);
  }
});

test('zero records still yields a readable card and oversized rows fail before sending', () => {
  assert.match(JSON.stringify(buildFeishuReportCards('# 巡检\n本轮未发现待处理记录。')), /本轮未发现/);
  assert.throws(() => buildFeishuReportCards('# 巡检\n' + header + '| 123 | now | ' + 'a'.repeat(20000) + ' |\n'), /过长/);
});

test('generic report continuation retains all configured grouping levels',()=>{
  const cards=buildFeishuReportCards('# 分组报告\n\n## 渠道 A\n\n### AR\n\n#### 产品 P\n\n##### 批次 B\n\n'+header
    +Array.from({length:70},(_,i)=>row(i)).join(''));
  assert.ok(cards.length>1);
  for(const card of cards) {
    assert.match(JSON.stringify(card),/产品 P/);
    assert.match(JSON.stringify(card),/批次 B/);
  }
});
