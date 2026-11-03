import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalPalette } from '../src/main/common/terminal-palette.js';
import { terminalColors } from '../src/shared/terminal-colors.js';

for (const theme of ['light', 'dark']) {
  test(`${theme} startup supplies both native composer colors before a view attaches`, () => {
    const replies = [];
    const palette = new TerminalPalette(() => theme, reply => replies.push(reply));
    assert.equal(palette.consume('\x1b[c\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\'), '\x1b[c\x1b[6n');
    const rgb = color => color.slice(1).match(/../g).map(value => value.repeat(2)).join('/');
    assert.deepEqual(replies, [
      `\x1b]10;rgb:${rgb(terminalColors[theme].foreground)}\x1b\\`,
      `\x1b]11;rgb:${rgb(terminalColors[theme].background)}\x1b\\`
    ]);
  });
}

test('palette handles every query chunk boundary and leaves other terminal sequences intact', () => {
  for (const terminator of ['\x07', '\x1b\\']) {
    const query = `\x1b]11;?${terminator}`;
    for (let split = 1; split < query.length; split++) {
      const replies = [];
      const palette = new TerminalPalette(() => 'light', reply => replies.push(reply));
      const first = palette.consume(`before${query.slice(0, split)}`);
      const second = palette.consume(`${query.slice(split)}after\x1b[48;2;244;244;244mtext\x1b[0m`);
      assert.equal(first + second, 'beforeafter\x1b[48;2;244;244;244mtext\x1b[0m');
      assert.equal(replies.length, 1);
    }
  }
  const palette = new TerminalPalette(() => 'dark', () => assert.fail('not a color query'));
  assert.equal(palette.consume('\x1b]0;window title\x07\x1b]11;#222222\x07'), '\x1b]0;window title\x07\x1b]11;#222222\x07');
});

test('future color queries follow theme changes without sending user input', () => {
  let theme = 'light';
  const replies = [];
  const palette = new TerminalPalette(() => theme, reply => replies.push(reply));
  palette.consume('\x1b]11;?\x07');
  theme = 'dark';
  palette.consume('\x1b]11;?\x07');
  assert.equal(replies[0], '\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
  assert.equal(replies[1], '\x1b]11;rgb:2020/2222/2727\x1b\\');
});

test('a failed backend reply leaves the query available to the terminal renderer', () => {
  const palette = new TerminalPalette(() => 'dark', () => false);
  assert.equal(palette.consume('\x1b]11;?\x1b\\'), '\x1b]11;?\x1b\\');
});
