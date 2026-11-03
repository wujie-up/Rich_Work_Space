import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalSurfaces } from '../src/shared/terminal-surfaces.js';
import { terminalColors } from '../src/shared/terminal-colors.js';

test('cached native input backgrounds use a subtle theme palette across every chunk boundary', () => {
  for (const shade of ['58;60;64', '66;68;72', '67;69;73', '244;244;244', '249;249;249']) {
    const sequence = `\x1b[1;48;2;${shade}mquestion\x1b[0m`;
    for (let split = 0; split <= sequence.length; split++) {
      const render = terminalSurfaces();
      assert.equal(render(sequence.slice(0, split)) + render(sequence.slice(split)), '\x1b[1;48;5;255mquestion\x1b[0m');
    }
  }
  assert.equal(terminalColors.light.extendedAnsi[239], '#f5f5f5');
  assert.equal(terminalColors.dark.extendedAnsi[239], '#30343c');
});

test('normal terminal colors, text and non-SGR controls retain their original values', () => {
  const output = '\x1b[38;2;66;68;72mtext\x1b[48;2;120;10;20mred\x1b[0m\x1b[2J';
  assert.equal(terminalSurfaces()(output), output);
});
