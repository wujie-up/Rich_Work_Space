import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalMetadata } from '../src/shared/terminal-metadata.js';

const buffer = lines => ({ baseY: 0, length: lines.length, getLine: row => lines[row] === undefined ? undefined : {
  isWrapped: typeof lines[row] === 'object', translateToString: () => typeof lines[row] === 'object' ? lines[row].text : lines[row]
} });

test('extracts native model and effort without hiding shortcuts, warnings or assistant paths', () => {
  assert.deepEqual(terminalMetadata(buffer(['GPT-example · /assistant/output', '> Ask Codex to do anything', '',
    'GPT-6.1-Sol medium · /project', '? for shortcuts         1 warning'])), { model: 'GPT-6.1-Sol medium', rows: [3] });
});

test('recognizes wrapped footer and masks the repeated startup directory', () => {
  assert.deepEqual(terminalMetadata(buffer(['OpenAI Codex (v0.166.0)', '/project', 'permissions: YOLO mode',
    '> draft', 'GPT-6.1-Sol high · ', { text: '/long/project/path' }, '? for shortcuts'])),
  { model: 'GPT-6.1-Sol high', rows: [1, 4, 5] });
});

test('leaves unrelated output and unknown layouts unchanged', () => {
  assert.deepEqual(terminalMetadata(buffer(['GPT-model · /project', '/project', 'task completed'])), { model: '', rows: [] });
});


test('supports configured provider model names', () => {
  assert.deepEqual(terminalMetadata(buffer(['> draft', 'deepseek-chat medium · /project'])),
    { model: 'deepseek-chat medium', rows: [1] });
});
