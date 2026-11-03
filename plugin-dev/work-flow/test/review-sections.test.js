import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewSections } from '../src/shared/review-sections.js';

test('评审卡片中的选项逐项换行，折叠原文仍保留原始内容', () => {
  const detail = '采用哪种规则：A，需求审查通过后推进；B，等待完整验收。';
  const prompt = `待确认：${JSON.stringify([{ title: '确认推进规则', detail }])}`;
  const sections = formatReviewSections(prompt);
  assert.equal(sections[0].items[0].detail, '采用哪种规则：\n\nA，需求审查通过后推进；\n\nB，等待完整验收。');
  assert.equal(sections.at(-1).items[0].detail, prompt);
});

test('review sections put decisions first, rank only explicit priority and retain original', () => {
  const prompt = '第1轮评审结束\n汇总：未通过\n问题：["I-2：普通问题。详细说明", "P0 I-1：阻断问题。补充基线"]\n待确认：["Q-1：选择范围？A或B", "Q-1：选择范围？A或B"]';
  const sections = formatReviewSections(prompt);
  assert.equal(sections[0].title, '本轮结论');
  assert.equal(sections[1].title, '需要你确认');
  assert.equal(sections[1].items.length, 1);
  assert.equal(sections[2].items[0].priority, 'P0');
  assert.equal(sections.at(-1).items[0].detail, prompt);
  assert.equal(sections.at(-1).collapsed, true);
});

test('unrecognized or malformed review data remains plain text; conflicting decisions stay distinct', () => {
  assert.deepEqual(formatReviewSections('普通问题'), []);
  assert.deepEqual(formatReviewSections('问题：[broken'), []);
  const sections = formatReviewSections('待确认：["Q-1：A或B", "Q-1：A或C"]');
  assert.equal(sections.find(section => section.title === '需要你确认').items.length, 2);
});


test('structured context keeps the current question visible instead of burying it in source text', () => {
  const sections = formatReviewSections('汇总：本轮待确认\n问题：[]', '是否进入下一轮？');
  assert.equal(sections[0].title, '当前需要确认');
  assert.equal(sections[0].items[0].detail, '是否进入下一轮？');
});

test('a separately delivered priority question retains its title and details', () => {
  const question = 'P0 | 确认需求基线 | Q-001：提供原版或明确替代材料。';
  const sections = formatReviewSections(`本轮需要澄清需求。\n\n${question}`, question);
  assert.deepEqual(sections[0], { title: '当前需要确认', items: [
    { title: '确认需求基线', detail: 'Q-001：提供原版或明确替代材料。', priority: 'P0' }
  ] });
  assert.equal(sections.at(-1).collapsed, true);
  assert.ok(sections.at(-1).items[0].detail.includes('本轮需要澄清需求。'));
});

test('legacy round review does not repeat its full context and includes coverage and revisions', () => {
  const prompt = '请审核本轮结论\n汇总：需要修订\n问题：[]\n需求与设计对应关系：["需求A：设计覆盖"]\n设计修改：["补充接口契约"]';
  const sections = formatReviewSections(prompt, prompt);
  assert.equal(sections[0].title, '本轮结论');
  assert.deepEqual(sections.find(section => section.title === '覆盖与修订').items.map(item => item.detail),
    ['需求A：设计覆盖', '补充接口契约']);
  assert.equal(sections.filter(section => section.items.some(item => item.detail === prompt)).length, 1);
});

test('priority is read only from explicit leading markers, never from descriptive prose', () => {
  const sections = formatReviewSections('问题：["I-1 该问题不属于 P0 级别，请按普通建议处理", "[P1] 缺少验收标准"]');
  assert.equal(sections.find(section => section.title === '其他问题').items[0].priority, undefined);
  assert.equal(sections.find(section => section.title === '阻断与高优先级问题').items[0].priority, 'P1');
});

test('review cards retain supplied titles, sort each decision list and collapse reviewer evidence', () => {
  const prompt = '第2轮评审结束\n汇总：本轮未通过。先确认基线，再补齐设计。\n'
    + '问题：' + JSON.stringify(['P2 | 补充错误响应 | I-003：列出失败码与返回字段。',
      'P0 | 补齐需求基线 | I-001：提供同版需求、原型及变更记录。',
      'P1 | 冻结接口契约 | I-002：明确字段类型、必填项及空值语义。']) + '\n'
    + '待确认：' + JSON.stringify([{ priority: 'P2', title: '确定分期范围', detail: 'Q-002：本期交付还是延期？' },
      { priority: 'P0', title: '确认需求基线', detail: 'Q-001：选择原始需求或经确认的替代基线。' }]) + '\n'
    + '产品审核 · 需求覆盖：' + JSON.stringify({ passed: false, summary: '尚缺基线。', issues: ['缺少需求原型'], questions: [] });
  const sections = formatReviewSections(prompt, prompt);
  const questions = sections.find(section => section.title === '需要你确认');
  assert.deepEqual(questions.items.map(item => item.title), ['确认需求基线', '确定分期范围']);
  assert.equal(questions.items[0].detail, 'Q-001：选择原始需求或经确认的替代基线。');
  const issues = sections.filter(section => ['阻断与高优先级问题', '其他问题'].includes(section.title)).flatMap(section => section.items);
  assert.deepEqual(issues.map(item => item.title), ['补齐需求基线', '冻结接口契约', '补充错误响应']);
  assert.deepEqual(issues.map(item => item.priority), ['P0', 'P1', 'P2']);
  const evidence = sections.find(section => section.title.startsWith('产品审核'));
  assert.equal(evidence.collapsed, true);
  assert.ok(evidence.items.some(item => item.detail.includes('缺少需求原型')));
  assert.ok(!JSON.stringify(sections.filter(section => !section.collapsed)).includes('"passed"'));
});

test('legacy multiline review arrays become readable titles without changing unranked business decisions', () => {
  const prompt = '汇总：未通过\n问题：' + JSON.stringify([
    'I-001 (REQ-SOURCE-01)：补齐需求基线。需要同版原需求和变更记录。',
    'P3 | 调整文档排版 | 统一列表缩进。', 'P2 | 补充用例 | 增加失败路径。'
  ], null, 2) + '\n待确认：["Q-001：采用哪份需求基线？原版或替代版。"]';
  const sections = formatReviewSections(prompt);
  const issues = sections.find(section => section.title === '其他问题').items;
  assert.deepEqual(issues.map(item => item.title), ['补充用例', '调整文档排版', '补齐需求基线']);
  assert.match(issues[2].detail, /I-001/);
  assert.match(issues[2].detail, /需要同版原需求和变更记录/);
  assert.ok(!issues[2].detail.includes('补齐需求基线。'), 'the short title is not repeated in the details');
  assert.equal(issues[2].priority, undefined);
  assert.equal(sections.find(section => section.title === '需要你确认').items[0].title, '采用哪份需求基线？');
  assert.equal(sections.at(-1).items[0].detail, prompt);
});
