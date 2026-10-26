import { spawn } from 'node:child_process';
import { once } from 'node:events';

// A dedicated process group lets the owner stop descendants without touching unrelated services.
export function createStdioTransport(config, { ReadBuffer, serializeMessage }, report, log) {
  const buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
  let child;
  let closing;
  return {
    async start() {
      child = spawn(config.command, config.args, { cwd: config.cwd || undefined,
        env: { HOME: process.env.HOME, PATH: process.env.PATH, ...config.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => this.onerror?.(error));
      child.on('close', () => {
        this.close().then(() => this.onclose?.()).catch(error => log('error', error.message));
      });
      child.stdout.on('data', chunk => {
        try {
          buffer.append(chunk);
          let message;
          while ((message = buffer.readMessage()) !== null) { this.onmessage?.(message); }
        } catch (error) {
          this.onerror?.(error);
          this.close().catch(error => log('error', error.message));
        }
      });
      child.stderr.on('data', chunk => log('info', chunk.toString()));
      child.stdin.on('error', error => this.onerror?.(error));
      await once(child, 'spawn');
      report(child.pid, true);
    },
    async send(message) {
      const data = serializeMessage(message);
      if (Buffer.byteLength(data) > 1024 * 1024) { throw Error('MCP 消息超过 1 MiB'); }
      if (!child.stdin.write(data)) { await once(child.stdin, 'drain'); }
    },
    async close() {
      if (!child?.pid) { return; }
      if (closing) { return closing; }
      closing = (async () => {
        const pid = child.pid;
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') { throw error; } }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Descendants can outlive their parent; retain ownership until the group is stopped.
        report(pid, false);
        buffer.clear();
      })();
      return closing;
    }
  };
}
