const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { createInterface } = require('node:readline');

// This event loop never executes user code, so parent-pipe EOF can terminate a blocked script even before PID registration.
process.stdin.on('end', () => process.kill(-process.pid, 'SIGKILL'));
const lines = createInterface({ input: process.stdin });
lines.once('line', line => {
  let sent = false;
  const finish = result => {
    if (sent) {
      return;
    }
    sent = true;
    setImmediate(() => {
      process.stdout.write('', () => process.stderr.write('', () => {
        const protocol = createWriteStream(null, { fd: 3 });
        protocol.on('error', () => process.kill(-process.pid, 'SIGKILL'));
        protocol.end(result);
      }));
    });
  };
  try {
    const { executable, args, body } = JSON.parse(line);
    // The execution child stays inside this supervisor's group; host shutdown and parent EOF terminate the entire group.
    const child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const result = [];
    let size = 0;
    child.stdio[3].on('data', chunk => {
      size += chunk.length;
      if (size > 4194304) {
        child.stdio[3].pause();
        finish(JSON.stringify({ ok: false, code: 'SCRIPT_OUTPUT_LIMIT', error: '脚本结果超过4MiB' }));
        return;
      }
      result.push(chunk);
      // A complete JSON line is the commit point; inherited log pipes must not delay returning the result.
      if (chunk.includes(10)) {
        finish(Buffer.concat(result));
      }
    });
    child.stdio[3].on('error', () => finish(JSON.stringify({ ok: false, error: '脚本结果管道失败' })));
    child.once('error', error => finish(JSON.stringify({ ok: false,
      code: error.code === 'ENOENT' ? 'SCRIPT_RUNTIME_MISSING' : 'SCRIPT_START_FAILED',
      error: error.code === 'ENOENT' ? 'Python解释器不存在，请配置已安装的解释器路径' : '脚本启动失败' })));
    child.once('close', code => {
      finish(code === 0 && result.length ? Buffer.concat(result) : JSON.stringify({ ok: false, error: `脚本异常退出：${code}` }));
    });
    child.stdin.on('error', error => finish(JSON.stringify({ ok: false, error: `脚本输入管道失败：${error.code || 'UNKNOWN'}` })));
    child.stdin.end(JSON.stringify(body));
  } catch {
    finish(JSON.stringify({ ok: false, error: '脚本启动协议无效' }));
  }
});
