import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUserInputPrompt } from '../src/renderer/user-input-prompt.js';

test('同一段中的选项逐项换行，保留选项内容及后续说明', () => {
  const prompt = 'Q10：请选择推进规则： A，按需求审查推进；B，保留当前门槛。A只改变推进时机。请选择A或B。';
  const expected = 'Q10：请选择推进规则：\n\nA，按需求审查推进；\n\nB，保留当前门槛。A只改变推进时机。请选择A或B。';
  assert.equal(formatUserInputPrompt(prompt), expected);
  assert.equal(formatUserInputPrompt(expected), expected);
  assert.equal(formatUserInputPrompt(JSON.stringify([prompt])), `1. ${expected}`);
});

test('兼容常用选项标记，保留普通字母引用、链接和既有排版', () => {
  for (const marker of ['、', '：', ')', '. ']) {
    assert.equal(formatUserInputPrompt(`选择：A${marker}第一项；B${marker}第二项；C${marker}第三项`),
      `选择：\n\nA${marker}第一项；\n\nB${marker}第二项；\n\nC${marker}第三项`);
  }
  for (const prompt of ['方案A，方案B，不做选项处理。', 'https://example.com/A/B', 'A：单个字段', 'A：原有选项\nB：另一选项']) {
    assert.equal(formatUserInputPrompt(prompt), prompt);
  }
});

test('用户问题数组按编号逐条显示，保留上下文和问题中的换行', () => {
  const questions = ['项目目录是什么？', '采用哪种对战方式？\n请说明先后顺序。'];
  assert.equal(formatUserInputPrompt(`请补充：\n${JSON.stringify(questions)}\n已有需求：保持原文`),
    '请补充：\n1. 项目目录是什么？\n2. 采用哪种对战方式？\n请说明先后顺序。\n已有需求：保持原文');
});

test('普通文本、非问题数组和代码按原文显示，HTML仍由文本节点呈现', () => {
  for (const prompt of ['<script>原文问题</script>', '[并非 JSON]', '[]', '[1,2]', '{"questions":["项目目录？"]}',
    '示例：["不独占一行"]', '[{"name":"问题"}]', '首行\n  缩进内容\n']) {
    assert.equal(formatUserInputPrompt(prompt), prompt);
  }
});
