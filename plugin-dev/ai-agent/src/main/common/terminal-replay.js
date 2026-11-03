// Keep one byte buffer per terminal; native redraws must not copy the entire history on every chunk.
export class TerminalReplay {
  constructor(limit) {
    this.limit = limit;
    this.buffer = null;
    this.length = 0;
    this.offset = 0;
    this.truncated = false;
  }

  append(data) {
    if (!data) {
      return;
    }
    this.buffer ||= Buffer.allocUnsafe(this.limit);
    const chunk = Buffer.from(data);
    const start = Math.max(0, chunk.length - this.limit);
    const length = chunk.length - start;
    const first = Math.min(length, this.limit - this.offset);
    chunk.copy(this.buffer, this.offset, start, start + first);
    chunk.copy(this.buffer, 0, start + first);
    this.offset = (this.offset + length) % this.limit;
    this.truncated ||= this.length + chunk.length > this.limit;
    this.length = Math.min(this.limit, this.length + length);
  }

  text() {
    if (!this.length) {
      return '';
    }
    let start = (this.offset - this.length + this.limit) % this.limit;
    let length = this.length;
    // A byte-limited tail may start inside a UTF-8 character, including at the ring boundary.
    while (length && (this.buffer[start] & 0xc0) === 0x80) {
      start = (start + 1) % this.limit;
      length--;
    }
    if (start + length <= this.limit) {
      return this.buffer.toString('utf8', start, start + length);
    }
    return Buffer.concat([this.buffer.subarray(start), this.buffer.subarray(0, length - this.limit + start)]).toString();
  }
}
