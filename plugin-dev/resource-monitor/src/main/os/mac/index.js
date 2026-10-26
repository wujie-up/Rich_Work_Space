import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';

function cpuTime(value) {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  return (Number(days) * 86400 + clock.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0)) * 1000;
}

export function parseProcesses(text) {
  const lines = text.trim().split('\n');
  return lines.map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+([\d:.\-]+)\s+(\d+)$/);
    if (!match || !Number.isFinite(cpuTime(match[4]))) {
      throw Error('无法解析系统进程计数');
    }
    return { pid: Number(match[1]), ppid: Number(match[2]), start: match[3], cpuMs: cpuTime(match[4]), rss: Number(match[5]) * 1024 };
  });
}

export function parseNetwork(text) {
  const lines = text.trim().split('\n');
  const header = lines.shift().split(',');
  const incoming = header.indexOf('bytes_in');
  const outgoing = header.indexOf('bytes_out');
  if (incoming < 0 || outgoing < 0) {
    throw Error('无法读取系统网络计数（nettop）');
  }
  const result = new Map();
  for (const line of lines.filter(Boolean)) {
    const fields = line.split(',');
    const pid = fields[0].match(/\.(\d+)$/)?.[1];
    const received = Number(fields[incoming]);
    const sent = Number(fields[outgoing]);
    if (!pid || !Number.isFinite(received) || !Number.isFinite(sent) || received < 0 || sent < 0) {
      throw Error('系统网络计数格式无效');
    }
    result.set(Number(pid), { received, sent });
  }
  return result;
}

export function createPlatform({ ownProcesses = () => {} } = {}) {
  const active = new Set();
  const report = () => ownProcesses([...active].map(child => child.pid).filter(Number.isInteger));
  const command = (file, args, signal) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { signal, detached: true, timeout: 1500, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (error, stdout) => {
      active.delete(child);
      report();
      if (error) {
        reject(error);
      } else {
        resolve({ pid: child.pid, stdout });
      }
    });
    active.add(child);
    report();
  });
  return {
    async sample({ signal }) {
      const [processes, network] = await Promise.allSettled([
        command('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,rss='], signal)
          .then(({ pid, stdout }) => ({ pid, value: parseProcesses(stdout) })),
        command('/usr/bin/nettop', ['-P', '-L', '1', '-n', '-x', '-J', 'bytes_in,bytes_out'], signal)
          .then(({ pid, stdout }) => ({ pid, value: parseNetwork(stdout) }))
      ]);
      // Collector PIDs change on every sample; including them would continually reset our own CPU baseline.
      const collectors = new Set([processes, network].filter(result => result.status === 'fulfilled').map(result => result.value.pid));
      return { time: performance.timeOrigin + performance.now(), cores: availableParallelism(),
        processes: processes.status === 'fulfilled' ? processes.value.value.filter(row => !collectors.has(row.pid)) : null,
        processError: processes.status === 'rejected' ? `进程采集不可用：${processes.reason.message}` : null,
        network: network.status === 'fulfilled' ? network.value.value : null,
        networkError: network.status === 'rejected' ? `网络采集不可用：${network.reason.message}` : null };
    },
    async close() {
      await Promise.all([...active].map(child => new Promise(resolve => {
        child.once('close', resolve);
        child.kill('SIGKILL');
      })));
    }
  };
}
