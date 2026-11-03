import { terminalColors } from '../../shared/terminal-colors.js';

const queries = [10, 11].flatMap(slot => ['\x07', '\x1b\\'].map(end => `\x1b]${slot};?${end}`));
const rgb = color => color.slice(1).match(/../g).map(value => value.repeat(2)).join('/');

// Codex caches its composer palette after a 250 ms probe, often before the view is mounted.
export class TerminalPalette {
  constructor(theme, reply) {
    this.theme = theme;
    this.reply = reply;
    this.pending = '';
  }

  consume(data) {
    const output = (this.pending + data).replace(/\x1b\](10|11);\?(?:\x07|\x1b\\)/g, (query, slot) => {
      const colors = terminalColors[this.theme()];
      const color = slot === '10' ? colors.foreground : colors.background;
      return this.reply(`\x1b]${slot};rgb:${rgb(color)}\x1b\\`) === false ? query : '';
    });
    // Only a possible query prefix is retained; logs and all other escape sequences pass through unchanged.
    let length = Math.min(output.length, 8);
    while (length && !queries.some(query => query.length > length && query.startsWith(output.slice(-length)))) {
      length--;
    }
    this.pending = length ? output.slice(-length) : '';
    return length ? output.slice(0, -length) : output;
  }
}
