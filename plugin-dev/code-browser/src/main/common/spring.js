import { randomUUID } from 'node:crypto';
import { mavenCommand } from './maven.js';
import { launch, terminate } from '../os/index.js';
import { fail } from './workspace.js';

// Mask comments and literals so example text cannot be discovered as an application.
function declarations(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, value => value.replace(/[^\n]/g, ' '));
}

export async function springApps(workspace, signal) {
  const pending = [{ path: '', module: null }];
  const apps = [];
  const deadline = Date.now() + 10000;
  let visited = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    if (visited >= 10000 || apps.length >= 200 || Date.now() >= deadline) {
      return { apps, truncated: true };
    }
    const entry = pending.pop();
    const result = await workspace.list({ path: entry.path });
    visited += result.entries.length;
    const module = result.entries.some(file => !file.directory && file.name === 'pom.xml') ? entry.path : entry.module;
    for (const file of result.entries) {
      signal?.throwIfAborted();
      if (apps.length >= 200 || Date.now() >= deadline) {
        return { apps, truncated: true };
      }
      if (file.directory && file.name !== 'test') {
        pending.push({ path: file.path, module });
      } else if (!file.directory && file.name.endsWith('.java') && module !== null) {
        const source = await workspace.text(file.path).catch(error => {
          if (['NOT_TEXT', 'FILE_LIMIT', 'ENOENT', 'EACCES'].includes(error.code)) {
            return '';
          }
          throw error;
        });
        const text = declarations(source);
        if (!/@(?:[\w.]+\.)?(?:SpringBootApplication|SpringBootConfiguration)\b/.test(text)
            || !/\bpublic\s+static\s+void\s+main\s*\(\s*(?:java\.lang\.)?String\s*(?:\[\s*\]|\.\.\.)/.test(text)) {
          continue;
        }
        const name = /\b(?:public\s+)?class\s+([\w$]+)/.exec(text)?.[1];
        const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(text)?.[1];
        if (name) {
          apps.push({ path: file.path, module, name, mainClass: pkg ? `${pkg}.${name}` : name });
        }
      }
    }
    if (result.truncated) {
      return { apps, truncated: true };
    }
  }
  return { apps: apps.sort((a, b) => a.path.localeCompare(b.path)), truncated: false };
}

export class SpringRunner {
  constructor(report = () => {}) {
    this.report = report;
    this.jobs = new Map();
    this.starting = false;
    this.stopped = false;
  }

  get busy() {
    return this.starting || [...this.jobs.values()].some(job => job.result.state === 'running');
  }

  tasks() {
    return [...this.jobs.values()].map(({ result: { log, ...result } }) => ({ ...result }));
  }

  snapshot(id) {
    const job = this.jobs.get(id);
    if (!job) {
      throw fail('TASK_CHANGED', '启动任务不存在');
    }
    return { ...job.result };
  }

  reportProcesses() {
    this.report([...this.jobs.values()].filter(job => job.result.state === 'running' && job.child.pid).map(job => job.child.pid));
  }

  async start(workspace, { path }, signal) {
    if (this.stopped || this.starting) {
      throw fail('SPRING_BUSY', '插件已停止或正在启动项目');
    }
    if ([...this.jobs.values()].filter(job => job.result.state === 'running').length >= 8) {
      throw fail('SPRING_BUSY', '最多同时启动 8 个项目');
    }
    this.starting = true;
    try {
      const app = (await springApps(workspace, signal)).apps.find(app => app.path === path);
      if (!app) {
        throw fail('NO_SPRING_APP', '未发现所选 Maven 项目的 Spring Boot 启动类，请刷新列表');
      }
      if ([...this.jobs.values()].some(job => job.result.path === path && job.result.state === 'running')) {
        throw fail('SPRING_BUSY', '所选启动类已经在运行');
      }
      const selected = await mavenCommand(workspace, app.module, [
        '--batch-mode', '--no-transfer-progress', '-Dstyle.color=never', 'spring-boot:run', `-Dspring-boot.run.main-class=${app.mainClass}`
      ]);
      signal?.throwIfAborted();
      if (this.stopped) {
        throw fail('STOPPED', '插件已停止');
      }
      // Keep only the latest task per application; logs remain bounded across restarts.
      for (const [id, job] of this.jobs) {
        if (job.result.path === path || job.result.root !== workspace.root) {
          this.jobs.delete(id);
        }
      }
      const child = launch(selected.command, selected.args, selected.cwd);
      const job = { child, result: { ...app, id: randomUUID(), root: workspace.root, state: 'running',
        command: selected.label, startedAt: Date.now(), exitCode: null, error: null, log: '', truncated: false } };
      this.jobs.set(job.result.id, job);
      job.completion = new Promise(done => child.once('close', async code => {
        this.terminate(job);
        await job.termination;
        job.result.exitCode = code;
        job.result.state = job.cancelled ? 'stopped' : code === 0 && !job.result.error ? 'exited' : 'failed';
        this.reportProcesses();
        const log = job.result.state === 'failed' ? console.error : console.info;
        log('[coding:spring:finish]', { pluginId: 'code-browser', taskId: job.result.id, path, state: job.result.state });
        done();
      }));
      child.once('error', error => {
        job.result.error = error.code === 'ENOENT' ? '未找到 Maven，请安装 mvn 或提供 mvnw' : error.message;
        console.error('[coding:spring:error]', { pluginId: 'code-browser', taskId: job.result.id, path, message: job.result.error });
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', text => {
          const bytes = Buffer.from(job.result.log + text);
          job.result.truncated ||= bytes.length > 128 * 1024;
          job.result.log = (bytes.length > 128 * 1024 ? bytes.subarray(bytes.length - 128 * 1024 + 4) : bytes).toString('utf8');
        });
      }
      this.reportProcesses();
      console.info('[coding:spring:start]', { pluginId: 'code-browser', taskId: job.result.id, path, module: app.module });
      return this.snapshot(job.result.id);
    } finally {
      this.starting = false;
    }
  }

  terminate(job) {
    if (!job.termination) {
      terminate(job.child, 'SIGTERM');
      // Wrappers may exit first; wait until their entire process group is cleaned up.
      job.termination = new Promise(done => setTimeout(() => {
        terminate(job.child, 'SIGKILL');
        done();
      }, 750));
    }
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    this.snapshot(id);
    if (job.result.state === 'running') {
      job.cancelled = true;
      this.terminate(job);
      await job.completion;
    }
    return this.snapshot(id);
  }

  async stop() {
    this.stopped = true;
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
  }
}
