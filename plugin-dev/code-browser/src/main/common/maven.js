import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launch, terminate } from '../os/index.js';
import { lifecycles } from './maven-phases.js';
import { fail, relativePath } from './workspace.js';

const phases = new Set(Object.values(lifecycles).flat());
const maxLogBytes = 128 * 1024;

async function commandFor(workspace, path, options) {
  const args = ['--batch-mode', '--no-transfer-progress', '-Dstyle.color=never'];
  await workspace.locate(path);
  const pom = await workspace.locate(join(path, 'pom.xml')).catch(error => {
    if (error.code === 'ENOENT') {
      throw fail('NO_POM', '所选目录没有 pom.xml，请选择 Maven 项目或模块目录');
    }
    throw error;
  });
  if (!(await stat(pom)).isFile()) {
    throw fail('NO_POM', 'pom.xml 必须是普通文件');
  }
  if (options.skipTests) {
    args.push('-DskipTests');
  }
  if (options.alsoMake && path) {
    const rootPom = await workspace.locate('pom.xml');
    if (!(await stat(rootPom)).isFile()) {
      throw fail('NO_POM', '依赖构建需要项目根目录的 pom.xml');
    }
    args.push('-f', rootPom, '-pl', `./${path}`, '-am');
  }
  args.push(...(options.clean && options.phase !== 'clean' ? ['clean'] : []), options.phase);
  return mavenCommand(workspace, path, args);
}

// Share wrapper selection with long-running Spring Boot applications.
export async function mavenCommand(workspace, path, args) {
  const cwd = await workspace.locate(path);
  for (const candidate of [...new Set([join(path, 'mvnw'), 'mvnw'])]) {
    if (await access(join(workspace.root, candidate)).then(() => true, error => {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    })) {
      const wrapper = await workspace.locate(candidate);
      if (!(await stat(wrapper)).isFile()) {
        throw fail('INVALID_WRAPPER', 'mvnw 必须是普通文件');
      }
      // Official POSIX wrappers can run through sh without changing their executable bit.
      return { command: '/bin/sh', args: [wrapper, ...args], cwd, label: `${candidate} ${args.join(' ')}` };
    }
  }
  return { command: 'mvn', args, cwd, label: `mvn ${args.join(' ')}` };
}

export class MavenBuild {
  constructor(report = () => {}, { timeoutMs = 600000 } = {}) {
    this.report = report;
    this.timeoutMs = timeoutMs;
    this.stopped = false;
    this.starting = false;
    this.job = null;
  }

  snapshot() {
    return this.job ? { ...this.job.result } : null;
  }

  async start(workspace, { path = '', phase = 'compile', clean = false, skipTests = false, alsoMake = false } = {}) {
    if (!phases.has(phase) || [clean, skipTests, alsoMake].some(value => typeof value !== 'boolean')) {
      throw fail('INVALID_INPUT', '请选择有效的 Maven 生命周期阶段及构建选项');
    }
    if (this.stopped) {
      throw fail('STOPPED', '插件已停止');
    }
    if (this.starting || this.job?.result.state === 'running') {
      throw fail('BUILD_BUSY', '正在编译，请先停止当前任务');
    }
    this.starting = true;
    try {
      const selected = await commandFor(workspace, relativePath(path), { phase, clean, skipTests, alsoMake });
      if (this.stopped) {
        throw fail('STOPPED', '插件已停止');
      }
      const child = launch(selected.command, selected.args, selected.cwd);
      const job = { child, result: { id: randomUUID(), state: 'running', path, phase, clean, skipTests, alsoMake, directory: selected.cwd, command: selected.label,
        startedAt: Date.now(), finishedAt: null, exitCode: null, log: '', truncated: false, error: null } };
      this.job = job;
      job.completion = new Promise(done => child.once('close', async (code, signal) => {
        clearTimeout(job.timer);
        this.terminate(job);
        await job.termination;
        job.result.exitCode = code;
        job.result.finishedAt = Date.now();
        job.result.state = job.reason === 'cancelled' ? 'cancelled' : code === 0 && !job.reason && !job.result.error ? 'succeeded' : 'failed';
        job.result.error ||= job.reason === 'timeout' ? '编译超过 10 分钟，已超时停止'
          : job.reason === 'cancelled' ? null : code === 0 ? null : `Maven 编译失败（${signal || code}），请查看日志`;
        this.report([]);
        const log = job.result.state === 'failed' ? console.error : console.info;
        log('[coding:maven:finish]', { pluginId: 'code-browser', taskId: job.result.id, path, state: job.result.state, exitCode: code });
        done();
      }));
      child.once('error', error => {
        job.result.error = error.code === 'ENOENT' ? '未找到 mvn；请提供项目 mvnw 或安装 Maven，并确保工作台 PATH 可访问'
          : `无法启动 Maven：${error.message}`;
        this.append(job, `${job.result.error}\n`);
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', text => this.append(job, text));
      }
      if (child.pid) {
        this.report([child.pid]);
      }
      job.timer = setTimeout(() => this.interrupt(job, 'timeout'), this.timeoutMs);
      console.info('[coding:maven:start]', { pluginId: 'code-browser', taskId: job.result.id, path, command: selected.label });
      return this.snapshot();
    } finally {
      this.starting = false;
    }
  }

  append(job, text) {
    const bytes = Buffer.from(job.result.log + text);
    job.result.truncated ||= bytes.length > maxLogBytes;
    job.result.log = bytes.length > maxLogBytes ? bytes.subarray(bytes.length - maxLogBytes + 4).toString('utf8') : bytes.toString('utf8');
  }

  interrupt(job, reason) {
    if (job.reason || job.result.state !== 'running') {
      return;
    }
    job.reason = reason;
    this.terminate(job);
  }

  terminate(job) {
    if (job.termination) {
      return;
    }
    terminate(job.child, 'SIGTERM');
    // A wrapper may exit before its detached descendants; finish cleanup before releasing ownership.
    job.termination = new Promise(done => setTimeout(() => {
      terminate(job.child, 'SIGKILL');
      done();
    }, 750));
  }

  async cancel(id) {
    if (!this.job || id !== this.job.result.id) {
      throw fail('BUILD_CHANGED', '编译任务不存在或已更新');
    }
    this.interrupt(this.job, 'cancelled');
    await this.job.completion;
    return this.snapshot();
  }

  async stop() {
    this.stopped = true;
    if (this.job) {
      this.interrupt(this.job, 'cancelled');
      await this.job.completion;
    }
  }
}
