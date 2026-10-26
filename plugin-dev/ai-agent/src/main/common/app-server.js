import { spawn } from 'node:child_process';

// The native protocol is JSON-lines (without a JSON-RPC version field), never terminal screen scraping.
export class AppServer {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn;
    this.onEvent = options.onEvent || (() => {});
    this.onExit = options.onExit || (() => {});
    this.onSpawn = options.onSpawn || (() => {});
    this.pending = new Map();
    this.approvals = new Set();
    this.sequence = 0;
  }

  async start(launch) {
    this.child = this.spawn(launch.command, launch.protocolArgs || [...launch.args, 'app-server', '--listen', 'stdio://'], {
      cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(Error(`受管引擎退出 (${code ?? signal})`));
      this.onExit({ code, signal });
    });
    this.onSpawn();
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        this.fail(Error('引擎协议帧过大'));
        this.close();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try {
            this.receive(JSON.parse(line));
          } catch (error) {
            this.fail(Error(`引擎协议错误：${error.message}`));
            this.close();
          }
        }
      }
    });
    // stderr can contain credential-bearing provider errors; keep them out of host logs and UI broadcasts.
    this.child.stderr.resume();
    const result = await this.request('initialize', {
      clientInfo: { name: 'work_desk_ai', title: 'Work Desk AI', version: '0.5.0' }, capabilities: { experimentalApi: false }
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  receive(message) {
    if (message.method) {
      if (message.id !== undefined) {
        this.approvals.add(message.id);
      }
      this.onEvent(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    message.error ? pending.reject(Object.assign(Error(message.error.message), { code: message.error.code })) : pending.resolve(message.result);
  }

  send(message) {
    if (this.closed) {
      throw Error('受管引擎已退出');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`引擎请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id, result) {
    if (!this.approvals.delete(id)) {
      throw Error('审批已失效');
    }
    this.send({ id, result });
  }

  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.approvals.clear();
  }

  close() {
    this.fail(Error('受管引擎已退出'));
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
  }

  async closeTask() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode) { this.close(); return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.close();
    });
  }
}
