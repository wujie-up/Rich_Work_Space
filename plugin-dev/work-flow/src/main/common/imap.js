import net from 'node:net';
import tls from 'node:tls';
import { fail } from './errors.js';
import { parseMessage } from './mime.js';

const CRLF = '\r\n';
const DEFAULT_TIMEOUT = 20000;
const MAX_TEXT_CHARS = 20000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Quoted arguments are enough for credentials here; literals would add unnecessary continuation handling.
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class ImapConnection {
  constructor(socket, { timeout = DEFAULT_TIMEOUT }) {
    Object.assign(this, { socket, timeout });
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.responses = [];
    this.waiter = null;
    this.greeted = false;
    this.greeting = new Promise(resolve => { this.greetingResolve = resolve; });
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    socket.on('error', error => this.#reject(fail('IMAP_ERROR', `邮件连接错误：${error.message}`)));
    socket.on('close', () => this.#reject(fail('IMAP_CLOSED', '邮件连接已关闭')));
  }

  static async open({ host, port = 993, security = 'tls', timeout = DEFAULT_TIMEOUT }) {
    const socket = await connect({ host, port, security, timeout });
    if (security !== 'starttls') {
      const connection = new ImapConnection(socket, { timeout });
      await connection.ready();
      return connection;
    }
    // STARTTLS upgrades the existing socket, so the plain listeners must be dropped first.
    const plain = new ImapConnection(socket, { timeout });
    await plain.ready();
    await plain.execute('STARTTLS');
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    const upgraded = await wrapSecure(socket, host, timeout);
    return new ImapConnection(upgraded, { timeout });
  }

  async ready() {
    const greeting = await this.greeting;
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
      throw fail('IMAP_HANDSHAKE_FAILED', `邮件服务器不可用：${greeting}`);
    }
  }

  async login({ username, password }) {
    await this.execute(`LOGIN ${quote(username)} ${quote(password)}`);
  }

  async selectMailbox(name) {
    const { data } = await this.execute(`SELECT ${quote(name)}`);
    const exists = data.map(entry => entry.line).find(line => /^\* \d+ EXISTS/i.test(line));
    return exists ? Number(exists.match(/(\d+)/)[1]) : 0;
  }

  async search(criteria) {
    const { data } = await this.execute(criteria.length ? `SEARCH ${criteria.join(' ')}` : 'SEARCH ALL');
    const ids = [];
    for (const entry of data) {
      if (!/^\* SEARCH/i.test(entry.line)) {
        continue;
      }
      // Trailing tokens may be empty, and Number('') would become the invalid sequence 0.
      const numbers = entry.line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number);
      ids.push(...numbers.filter(value => Number.isInteger(value) && value > 0));
    }
    return [...new Set(ids)].sort((left, right) => left - right);
  }

  async fetchBodies(ids) {
    const { data } = await this.execute(`FETCH ${sequenceSet(ids)} (BODY.PEEK[])`);
    const bodies = new Map();
    for (const entry of data) {
      const matched = /^\* (\d+) FETCH/i.exec(entry.line);
      if (matched && entry.data) {
        bodies.set(Number(matched[1]), entry.data.toString('utf8'));
      }
    }
    return bodies;
  }

  async logout() {
    if (this.closed) {
      return;
    }
    await this.execute('LOGOUT').catch(() => {});
    this.close();
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
  }

  execute(command) {
    const tag = `A${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#reject(fail('IMAP_TIMEOUT', `邮件命令超时：${command.split(' ')[0]}`)), this.timeout);
      this.waiter = { tag, resolve: resolved => { clearTimeout(timer); resolve(resolved); },
        reject: error => { clearTimeout(timer); this.close(); reject(error); } };
      this.socket.write(`${tag} ${command}${CRLF}`);
    });
  }

  #drain() {
    const responses = this.#responses();
    if (responses === null) {
      return;
    }
    for (const response of responses) {
      this.#receive(response);
    }
  }

  // Literal announcements ({n}) are followed by exactly n bytes, so responses must be framed from bytes.
  #responses() {
    let index = 0;
    const responses = [];
    while (index < this.buffer.length) {
      const lineEnd = this.buffer.indexOf(CRLF, index);
      if (lineEnd < 0) {
        return null;
      }
      const line = this.buffer.subarray(index, lineEnd).toString('utf8');
      index = lineEnd + CRLF.length;
      const literal = /\{(\d+)\}\s*$/.exec(line);
      if (literal) {
        const size = Number(literal[1]);
        if (this.buffer.length < index + size) {
          return null;
        }
        responses.push({ line: line.slice(0, literal.index).trimEnd(), data: Buffer.from(this.buffer.subarray(index, index + size)) });
        index += size;
        continue;
      }
      responses.push({ line, data: null });
    }
    this.buffer = Buffer.from(this.buffer.subarray(index));
    return responses;
  }

  #receive(response) {
    if (!this.waiter) {
      if (!this.greeted) {
        this.greeted = true;
        this.greetingResolve(response.line);
      }
      return;
    }
    if (response.line.startsWith(`${this.waiter.tag} `)) {
      const waiter = this.waiter;
      const status = response.line.slice(this.waiter.tag.length + 1);
      const collected = this.responses;
      this.waiter = null;
      this.responses = [];
      if (/^OK\b/i.test(status)) {
        waiter.resolve({ status, data: collected });
        return;
      }
      waiter.reject(fail('IMAP_COMMAND_FAILED', `邮件服务器拒绝命令：${status}`));
      return;
    }
    this.responses.push(response);
  }

  #reject(error) {
    const waiter = this.waiter;
    this.waiter = null;
    this.close();
    waiter?.reject(error);
  }
}

async function connect({ host, port, security, timeout }) {
  const socket = security === 'none' || security === 'starttls' ? net.connect({ host, port }) : tls.connect({ host, port, servername: host });
  await wait(socket, security === 'tls' ? 'secureConnect' : 'connect', timeout, '连接邮件服务器超时');
  return socket;
}

async function wrapSecure(socket, host, timeout) {
  const upgraded = tls.connect({ socket, servername: host });
  await wait(upgraded, 'secureConnect', timeout, '升级加密连接超时');
  return upgraded;
}

function wait(socket, event, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(fail('IMAP_TIMEOUT', message)); }, timeout);
    socket.once(event, () => { clearTimeout(timer); socket.removeAllListeners('error'); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(fail('IMAP_CONNECT_FAILED', `无法连接邮件服务器：${error.message}`)); });
  });
}

function sequenceSet(ids) {
  const ranges = [];
  for (const id of ids) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === id - 1) {
      last.end = id;
      continue;
    }
    ranges.push({ start: id, end: id });
  }
  return ranges.map(range => (range.start === range.end ? `${range.start}` : `${range.start}:${range.end}`)).join(',');
}

function sinceStamp(days) {
  const date = new Date(Date.now() - days * 86400000);
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

// Server-side SEARCH handles ASCII dates; keyword filtering stays local so Chinese filters also work.
export async function fetchErrorEmails({ credential, mailbox, sinceDays, keywords, limit, scanLimit, shouldStop, timeout }) {
  const connection = await ImapConnection.open({ host: credential.host, port: credential.port || 993,
    security: credential.security || 'tls', timeout });
  try {
    await connection.login({ username: credential.username, password: credential.password });
    await connection.selectMailbox(mailbox || 'INBOX');
    if (shouldStop?.()) {
      throw fail('RUN_CANCELED', '运行已停止');
    }
    const criteria = sinceDays > 0 ? ['SINCE', sinceStamp(sinceDays)] : [];
    const found = await connection.search(criteria);
    const candidates = found.slice(-Math.max(1, scanLimit));
    const bodies = candidates.length ? await connection.fetchBodies(candidates) : new Map();
    if (shouldStop?.()) {
      throw fail('RUN_CANCELED', '运行已停止');
    }
    const emails = [];
    for (const id of candidates) {
      const raw = bodies.get(id);
      if (!raw) {
        continue;
      }
      const message = parseMessage(raw);
      const haystack = `${message.subject}\n${message.text}`.toLowerCase();
      if (keywords.length && !keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) {
        continue;
      }
      emails.push({ id: String(id), from: message.from, subject: message.subject, date: message.date,
        text: message.text.slice(0, MAX_TEXT_CHARS) });
    }
    return emails.slice(-Math.max(1, limit)).reverse();
  } finally {
    await connection.logout();
  }
}
