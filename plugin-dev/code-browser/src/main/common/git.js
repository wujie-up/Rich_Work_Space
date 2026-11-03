import { execFile } from 'node:child_process';
import { fail, integer, relativePath, sourceLines } from './workspace.js';

const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

export class GitReader {
  constructor(report = () => {}) {
    this.children = new Map();
    this.report = report;
    this.stopped = false;
  }

  run(workspace, args, signal, maxBuffer = 128 * 1024) {
    signal?.throwIfAborted();
    if (this.stopped) {
      throw fail('STOPPED', '插件已停止');
    }
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
        '-C', workspace.root, ...args],
        { env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, timeout: 10000,
          killSignal: 'SIGKILL', maxBuffer, signal, encoding: 'buffer' }, (error, stdout, stderr) => {
          this.children.delete(child);
          this.report([...this.children.keys()].map(process => process.pid));
          if (!error) {
            try {
              resolve(new TextDecoder('utf-8', { fatal: true }).decode(stdout));
            } catch {
              reject(fail('NOT_TEXT', 'Git 内容不是 UTF-8 文本'));
            }
            return;
          }
          if (error.name === 'AbortError') {
            reject(error);
            return;
          }
          const message = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git 输出过大，请限定文件或缩小比较范围'
            : error.code === 'ENOENT' ? '未找到 Git，请安装 Git 并重启工作台'
              : error.killed ? 'Git 操作超时或已停止' : `Git 操作失败：${stderr.toString().trim().slice(0, 1000) || error.message}`;
          reject(fail('GIT_ERROR', message));
        });
      if (child.pid) {
        this.children.set(child, new Promise(done => child.once('close', done)));
        this.report([...this.children.keys()].map(process => process.pid));
      }
    });
  }

  async revision(workspace, value = 'HEAD', signal) {
    if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('-') || value.includes('\0')) {
      throw fail('INVALID_REVISION', '请输入有效的 Git 提交、分支或标签');
    }
    return (await this.run(workspace, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], signal)).trim();
  }

  async branches(workspace, signal) {
    const output = await this.run(workspace, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'], signal);
    return { branches: output.trimEnd().split('\n').filter(Boolean).map(ref => ({
      name: ref.replace(/^refs\/(heads|remotes)\//, ''), revision: ref
    })) };
  }

  async log(workspace, { revision = 'HEAD', path = '', limit = 30 } = {}, signal) {
    relativePath(path);
    integer(limit, 30, 1, 100);
    const commit = await this.revision(workspace, revision, signal);
    const output = await this.run(workspace, ['log', '--format=%H%x00%an%x00%aI%x00%s', `--max-count=${limit}`,
      commit, '--', path || '.'], signal);
    return { commits: output.trimEnd().split('\n').filter(Boolean).map(line => {
      const [hash, author, date, subject] = line.split('\0');
      return { hash, author, date, subject };
    }) };
  }

  async diff(workspace, { base = 'HEAD', target = 'WORKTREE', path = '', summary = false } = {}, signal) {
    relativePath(path);
    const from = await this.revision(workspace, base, signal);
    const to = ['WORKTREE', 'INDEX'].includes(target) ? target : await this.revision(workspace, target, signal);
    const revisions = to === 'INDEX' ? ['--cached', from] : to === 'WORKTREE' ? [from] : [from, to];
    // Git can run clean/process filters while reading worktree files, even with --no-textconv.
    const filters = to === 'WORKTREE' ? await this.disabledFilters(workspace, signal) : [];
    // Branch lists need only paths; patches are loaded separately when a file is expanded.
    const text = summary ? '' : await this.run(workspace, [...filters, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
      '--relative', '--unified=3', ...revisions, '--', path || '.'], signal, path ? 8 * 1024 * 1024 : 128 * 1024);
    const names = await this.run(workspace, [...filters, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--relative', '--name-status', '-z', ...revisions, '--', path || '.'], signal, summary ? 8 * 1024 * 1024 : 128 * 1024);
    const fields = names.split('\0');
    const patches = text.split(/^diff --git /m).slice(1).map(block => `diff --git ${block}`);
    const files = [];
    for (let index = 0; index < fields.length - 1; index += 2) {
      files.push({ status: fields[index], path: fields[index + 1], ...(summary ? {} : { text: patches[index / 2] || '' }) });
    }
    return { base: from, target: to, path, text, files };
  }

  async disabledFilters(workspace, signal) {
    const names = await this.run(workspace, ['config', '--null', '--name-only', '--list'], signal);
    const filters = new Set(names.split('\0').filter(name => /^filter\..+\.(clean|process|required)$/s.test(name))
      .map(name => name.slice(0, name.lastIndexOf('.'))));
    return [...filters].flatMap(name => ['-c', `${name}.clean=`, '-c', `${name}.process=`, '-c', `${name}.required=false`]);
  }

  async show(workspace, input, signal) {
    const path = relativePath(input.path, false);
    const revision = await this.revision(workspace, input.revision, signal);
    const prefix = (await this.run(workspace, ['rev-parse', '--show-prefix'], signal)).trimEnd();
    const text = await this.run(workspace, ['show', '--no-ext-diff', '--no-textconv', `${revision}:${prefix}${path}`], signal, 1024 * 1024);
    if (text.includes('\0')) {
      throw fail('NOT_TEXT', '历史文件不是 UTF-8 文本');
    }
    return { path, revision, ...sourceLines(text, input) };
  }

  // Only live ChildProcess objects created by this instance can be terminated.
  async stop() {
    this.stopped = true;
    const completions = [...this.children.values()];
    for (const child of this.children.keys()) {
      child.kill('SIGKILL');
    }
    await Promise.all(completions);
  }
}
