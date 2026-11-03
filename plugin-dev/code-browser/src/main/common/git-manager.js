import { realpath, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { gitActions } from './git-actions.js';
import { GitReader } from './git.js';
import { fail, relativePath } from './workspace.js';
import { launch, terminate } from '../os/index.js';

const maxLogBytes = 128 * 1024;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const redact = text => text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@');
const exists = path => access(path).then(() => true, error => {
  if (error.code === 'ENOENT') {
    return false;
  }
  throw error;
});

function branchName(value) {
  const name = typeof value === 'string' ? value.replace(/^refs\/heads\//, '') : value;
  if (typeof name !== 'string' || !name || name.length > 200 || name.startsWith('-') || /[\s\x00-\x1f~^:?*\[\\]/.test(name)
    || name.includes('..') || name.includes('@{') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    throw fail('INVALID_BRANCH', '请输入有效的 Git 分支名称');
  }
  return name;
}

function pathsFor(input) {
  if (input.all === true) {
    return ['.'];
  }
  if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 200) {
    throw fail('INVALID_PATH', '请选择 1–200 个仓库内文件，或选择全部');
  }
  return input.paths.map(path => relativePath(path, false));
}

export class GitManager {
  constructor(report = () => {}, { timeoutMs = 600000 } = {}) {
    this.report = report;
    this.reader = new GitReader(pids => {
      this.readPids = pids;
      this.reportPids();
    });
    this.readPids = [];
    this.timeoutMs = timeoutMs;
    this.starting = false;
    this.stopped = false;
    this.job = null;
  }

  reportPids() {
    this.report([...this.readPids, ...(this.job?.child?.pid && this.job.result.state === 'running' ? [this.job.child.pid] : [])]);
  }

  async repository(workspace, signal) {
    return realpath((await this.reader.run(workspace, ['rev-parse', '--show-toplevel'], signal)).trimEnd());
  }

  async status(workspace, signal) {
    const root = await this.repository(workspace, signal);
    const repo = { root };
    const filters = await this.reader.disabledFilters(repo, signal);
    const [head, refs, remotes, files, stashes, gitDirectory] = await Promise.all([
      this.reader.run(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal).catch(error => {
        if (error.code === 'GIT_ERROR') {
          return '';
        }
        throw error;
      }),
      this.reader.run(repo, ['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/', 'refs/remotes/'], signal),
      this.reader.run(repo, ['remote'], signal),
      this.reader.run(repo, [...filters, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal),
      this.reader.run(repo, ['stash', 'list', '--format=%gd%x00%s'], signal),
      this.reader.run(repo, ['rev-parse', '--absolute-git-dir'], signal)
    ]);
    const records = files.split('\0');
    const changes = [];
    for (let index = 0; index < records.length && records[index]; index++) {
      const entry = records[index];
      const renamed = entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C');
      changes.push({ path: entry.slice(3), index: entry[0], worktree: entry[1],
        ...(renamed ? { originalPath: records[++index] } : {}),
        conflict: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.slice(0, 2)) });
    }
    const dir = gitDirectory.trimEnd();
    const branches = refs.trimEnd().split('\n').filter(Boolean).map(line => {
      const [revision, marker, upstream, upstreamRemote, upstreamRef] = line.split('\0');
      return { revision, name: revision.replace(/^refs\/(heads|remotes)\//, ''),
        remote: revision.startsWith('refs/remotes/'), current: marker === '*', upstream, upstreamRemote, upstreamRef };
    });
    // An orphan branch may retain logs/HEAD even though HEAD cannot resolve yet.
    const hasHead = !head.trimEnd() || branches.some(branch => branch.current);
    const checkoutLog = hasHead && await exists(`${dir}/logs/HEAD`)
      ? await this.reader.run(repo, ['reflog', 'show', '-n', '40', '--format=%gs', 'HEAD'], signal) : '';
    const recent = [...new Set([head.trimEnd(), ...checkoutLog.split('\n').flatMap(line => {
      const checkout = /^checkout: moving from (.+) to (.+)$/.exec(line);
      return checkout ? [checkout[2], checkout[1]] : [];
    })])].filter(name => branches.some(branch => branch.name === name)).slice(0, 10);
    const operation = await exists(`${dir}/rebase-merge`) || await exists(`${dir}/rebase-apply`) ? 'rebase'
      : await exists(`${dir}/MERGE_HEAD`) ? 'merge' : await exists(`${dir}/CHERRY_PICK_HEAD`) ? 'cherry-pick'
        : await exists(`${dir}/REVERT_HEAD`) ? 'revert' : null;
    return { root, current: head.trimEnd() || null, operation, files: changes,
      branches, recent, remotes: remotes.trimEnd().split('\n').filter(Boolean),
      stashes: stashes.trimEnd().split('\n').filter(Boolean).map(line => {
        const [ref, subject] = line.split('\0');
        return { ref, subject };
      }) };
  }

  async command(workspace, input) {
    const state = await this.status(workspace);
    const repo = { root: state.root };
    const { action } = input;
    const selectedBranch = input.localBranch || state.current;
    const current = state.branches.find(branch => !branch.remote && branch.name === selectedBranch);
    if (['pull', 'push'].includes(action) && input.localBranch && !current) {
      throw fail('INVALID_BRANCH', '请选择现有本地分支');
    }
    if (state.operation && !['continue', 'abort', 'stage', 'unstage', 'discard'].includes(action)) {
      throw fail('GIT_IN_PROGRESS', `仓库正在进行 ${state.operation}，请先继续或中止`);
    }
    const changesWorktree = ['merge', 'rebase', 'cherryPick', 'revert'].includes(action)
      || action === 'pull' && selectedBranch === state.current;
    if (changesWorktree && state.files.length) {
      throw fail('GIT_DIRTY', '此操作需要干净工作区；请先提交或储藏修改');
    }
    // A staged rename is one UI row but both index paths must be unstaged together.
    const paths = () => [...new Set(pathsFor(input).flatMap(path => {
      const original = state.files.find(file => file.path === path)?.originalPath;
      return original ? [path, original] : [path];
    }))];
    const revision = () => this.reader.revision(repo, input.revision);
    const ref = async value => {
      const name = branchName(value);
      await this.reader.run(repo, ['check-ref-format', '--branch', name]);
      return name;
    };
    const remote = () => {
      if (typeof input.remote !== 'string' || !state.remotes.includes(input.remote) || input.remote.startsWith('-')) {
        throw fail('INVALID_REMOTE', '请选择已配置的远程仓库');
      }
      return input.remote;
    };
    const trackedBranch = () => current?.upstreamRemote === input.remote && current.upstreamRef?.startsWith('refs/heads/')
      ? current.upstreamRef.slice('refs/heads/'.length) : null;
    const stash = () => {
      if (typeof input.stash !== 'string' || !/^stash@\{\d+\}$/.test(input.stash) || !state.stashes.some(item => item.ref === input.stash)) {
        throw fail('INVALID_STASH', '请选择当前储藏记录');
      }
      return input.stash;
    };
    let args;
    switch (action) {
      case 'switch': {
        const selected = state.branches.find(item => item.revision === input.branch || item.name === input.branch);
        if (!selected) {
          throw fail('INVALID_BRANCH', '请选择现有分支');
        }
        args = selected.remote ? ['switch', '--track', '-c', await ref(input.newBranch || selected.name.slice(selected.name.indexOf('/') + 1)), selected.revision]
          : ['switch', '--', selected.name];
        break;
      }
      case 'createBranch':
        args = ['switch', '-c', await ref(input.newBranch), ...(input.revision ? [await revision()] : [])];
        break;
      case 'renameBranch':
        args = ['branch', '-m', await ref(input.branch), await ref(input.newBranch)];
        break;
      case 'deleteBranch':
        args = ['branch', '-d', '--', await ref(input.branch)];
        break;
      case 'fetch':
        args = ['fetch', '--prune', '--', remote()];
        break;
      case 'pull': {
        const mode = input.pullMode || 'ff-only';
        if (!['ff-only', 'merge', 'rebase'].includes(mode)) {
          throw fail('INVALID_INPUT', '请选择快进、merge 或 rebase 更新方式');
        }
        if (!selectedBranch) {
          throw fail('DETACHED_HEAD', '请先切换到本地分支');
        }
        if (selectedBranch !== state.current) {
          if (mode !== 'ff-only') {
            throw fail('INVALID_INPUT', '非当前分支只支持快进更新');
          }
          // Fetch rejects divergent updates and branches checked out in any worktree without force flags.
          args = ['fetch', '--', remote(), `${await ref(input.branch || trackedBranch() || selectedBranch)}:refs/heads/${await ref(selectedBranch)}`];
          break;
        }
        args = ['pull', ...(mode === 'ff-only' ? ['--ff-only'] : mode === 'rebase' ? ['--rebase'] : ['--no-rebase', '--no-edit']),
          '--', remote(), input.branch ? await ref(input.branch) : trackedBranch() || state.current];
        break;
      }
      case 'push':
        if (!selectedBranch) {
          throw fail('DETACHED_HEAD', '请先切换到本地分支');
        }
        args = ['push', ...(current?.upstream ? [] : ['--set-upstream']), '--', remote(),
          `refs/heads/${await ref(selectedBranch)}:refs/heads/${trackedBranch() || selectedBranch}`];
        break;
      case 'stage':
        args = ['add', '-A', '--', ...pathsFor(input)];
        break;
      case 'unstage': {
        const selectedPaths = paths();
        const head = await this.reader.revision(repo, 'HEAD').then(() => true, error => {
          if (error.code === 'GIT_ERROR') {
            return false;
          }
          throw error;
        });
        args = head ? ['reset', '-q', 'HEAD', '--', ...selectedPaths] : ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...selectedPaths];
        break;
      }
      case 'commit':
        if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 10000 || input.message.includes('\0')) {
          throw fail('INVALID_MESSAGE', '请输入不超过 10000 字符的提交说明');
        }
        args = ['commit', '-m', input.message];
        break;
      case 'merge':
        args = ['merge', '--no-edit', '--', await revision()];
        break;
      case 'rebase':
        args = ['rebase', '--', await revision()];
        break;
      case 'cherryPick':
        args = ['cherry-pick', await revision()];
        break;
      case 'revert': {
        if (input.mainline !== undefined && (!Number.isInteger(input.mainline) || input.mainline < 1 || input.mainline > 100)) {
          throw fail('INVALID_INPUT', '主线父编号应为 1–100');
        }
        args = ['revert', '--no-edit', ...(input.mainline ? ['-m', String(input.mainline)] : []), await revision()];
        break;
      }
      case 'continue':
      case 'abort':
        if (!state.operation) {
          throw fail('GIT_NOT_IN_PROGRESS', '没有可继续或中止的 Git 操作');
        }
        if (action === 'continue' && state.files.some(file => file.conflict)) {
          throw fail('GIT_CONFLICT', '请先解决冲突并暂存文件');
        }
        args = state.operation === 'merge' && action === 'continue' ? ['commit', '--no-edit'] : [state.operation, `--${action}`];
        break;
      case 'stashSave':
        if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 10000 || input.message.includes('\0'))) {
          throw fail('INVALID_MESSAGE', '储藏说明应为不超过 10000 字符的文本');
        }
        args = ['stash', 'push', ...(input.includeUntracked === true ? ['--include-untracked'] : []),
          ...(input.message ? ['-m', input.message] : [])];
        break;
      case 'stashApply':
      case 'stashPop':
      case 'stashDrop':
        args = ['stash', { stashApply: 'apply', stashPop: 'pop', stashDrop: 'drop' }[action], stash()];
        break;
      case 'reset':
        if (!['soft', 'mixed', 'hard'].includes(input.mode)) {
          throw fail('INVALID_INPUT', '请选择 soft、mixed 或 hard 回滚模式');
        }
        args = ['reset', `--${input.mode}`, await revision(), '--'];
        break;
      case 'discard':
        if (input.all === true) {
          throw fail('INVALID_PATH', '丢弃修改必须明确选择文件');
        }
        args = ['restore', '--worktree', '--', ...pathsFor(input)];
        break;
      default:
        throw fail('INVALID_INPUT', '不支持的 Git 操作');
    }
    return { root: state.root, args };
  }

  // Reuse the actual push refspec so the preview follows differently named upstream branches.
  async pushPreview(workspace, input, signal) {
    const { root, args } = await this.command(workspace, { ...input, action: 'push' });
    const [source, destination] = args.at(-1).split(':');
    const remote = args.at(-2);
    const state = await this.status(workspace, signal);
    const tracked = `refs/remotes/${remote}/${destination.replace(/^refs\/heads\//, '')}`;
    const exists = state.branches.some(branch => branch.revision === tracked);
    const output = await this.reader.run({ root }, exists
      ? ['diff', '--no-renames', '--name-status', '-z', tracked, source, '--']
      : ['ls-tree', '-r', '--name-only', '-z', source], signal, 8 * 1024 * 1024);
    const entries = output.split('\0').filter(Boolean);
    const files = [];
    for (let index = 0; index < entries.length; index += exists ? 2 : 1) {
      files.push({ status: exists ? entries[index] : 'A', path: entries[index + (exists ? 1 : 0)] });
    }
    return { source, destination: `${remote}/${destination.replace(/^refs\/heads\//, '')}`, files };
  }

  snapshot() {
    return this.job ? { ...this.job.result } : null;
  }

  async start(workspace, input = {}) {
    if (this.stopped) {
      throw fail('STOPPED', '插件已停止');
    }
    if (this.starting || this.job?.result.state === 'running') {
      throw fail('GIT_BUSY', 'Git 操作正在执行，请先等待或停止');
    }
    if (!Object.hasOwn(gitActions, input.action)) {
      throw fail('INVALID_INPUT', '不支持的 Git 操作');
    }
    if ((input.action === 'reset' && input.mode === 'hard' || ['discard', 'stashDrop'].includes(input.action)) && input.confirmed !== true) {
      throw fail('CONFIRM_REQUIRED', '此操作可能丢失本地修改，需要明确确认');
    }
    this.starting = true;
    try {
      const selected = await this.command(workspace, input);
      if (this.stopped) {
        throw fail('STOPPED', '插件已停止');
      }
      const child = launch('git', ['--no-pager', ...(['stage', 'unstage', 'discard'].includes(input.action) ? ['--literal-pathspecs'] : []), '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
        '-C', selected.root, ...selected.args], selected.root,
      { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GCM_INTERACTIVE: 'Never',
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' });
      const job = { child, result: { id: randomUUID(), action: input.action, state: 'running', root: selected.root,
        startedAt: Date.now(), finishedAt: null, exitCode: null, log: '', truncated: false, error: null } };
      this.job = job;
      this.reportPids();
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', text => this.append(job, text));
      }
      child.once('error', error => {
        job.result.error = error.code === 'ENOENT' ? '未找到 Git，请安装 Git 并重启工作台' : `无法启动 Git：${redact(error.message)}`;
      });
      job.completion = new Promise(done => child.once('close', async (code, signal) => {
        clearTimeout(job.timer);
        this.append(job, '', true);
        await this.cleanup(job);
        job.result.exitCode = code;
        job.result.finishedAt = Date.now();
        let finalState = job.reason === 'cancelled' ? 'cancelled' : code === 0 && !job.reason && !job.result.error ? 'succeeded' : 'failed';
        if (finalState === 'failed') {
          job.result.error ||= job.reason === 'timeout' ? 'Git 操作超过 10 分钟，已超时停止'
            : `Git 操作失败（${signal || code}），请查看日志`;
          try {
            const state = await this.status({ root: selected.root });
            if (state.files.some(file => file.conflict)) {
              finalState = 'conflicted';
              job.result.error = '存在冲突，请在外部编辑器解决并暂存后继续，或中止操作';
            }
          } catch (error) {
            this.append(job, `\n无法刷新仓库状态：${redact(error.message)}\n`);
          }
        }
        job.result.state = finalState;
        this.reportPids();
        const logger = job.result.state === 'failed' || job.result.state === 'conflicted' ? console.error : console.info;
        logger('[coding:git:finish]', { pluginId: 'code-browser', taskId: job.result.id, root: selected.root,
          action: input.action, state: job.result.state, exitCode: code });
        done({ ...job.result });
      }));
      job.timer = setTimeout(() => this.interrupt(job, 'timeout'), this.timeoutMs);
      console.info('[coding:git:start]', { pluginId: 'code-browser', taskId: job.result.id, root: selected.root, action: input.action });
      return this.snapshot();
    } finally {
      this.starting = false;
    }
  }

  // Buffer an incomplete line so credentials split between OS chunks never reach the UI.
  append(job, text, flush = false) {
    const output = (job.outputFragment || '') + text;
    const boundary = flush ? output.length : output.lastIndexOf('\n') + 1;
    job.outputFragment = output.slice(boundary);
    if (Buffer.byteLength(job.outputFragment) > maxLogBytes) {
      job.outputFragment = '';
      job.result.truncated = true;
    }
    const bytes = Buffer.from(job.result.log + redact(output.slice(0, boundary)));
    job.result.truncated ||= bytes.length > maxLogBytes;
    job.result.log = bytes.length > maxLogBytes ? bytes.subarray(bytes.length - maxLogBytes + 4).toString('utf8') : bytes.toString('utf8');
  }

  // Keep the lease until descendants are terminated, even if a hook outlives the Git process.
  cleanup(job) {
    if (!job.cleanup) {
      terminate(job.child, 'SIGTERM');
      job.cleanup = new Promise(done => setTimeout(() => { terminate(job.child, 'SIGKILL'); done(); }, 750));
    }
    return job.cleanup;
  }

  interrupt(job, reason) {
    if (job.result.state === 'running' && !job.reason) {
      job.reason = reason;
      void this.cleanup(job);
    }
  }

  async wait(id) {
    if (!this.job || this.job.result.id !== id) {
      throw fail('GIT_CHANGED', 'Git 任务不存在或已更新');
    }
    return this.job.completion;
  }

  async cancel(id) {
    if (!this.job || this.job.result.id !== id) {
      throw fail('GIT_CHANGED', 'Git 任务不存在或已更新');
    }
    this.interrupt(this.job, 'cancelled');
    return this.wait(id);
  }

  async stop() {
    this.stopped = true;
    if (this.job) {
      this.interrupt(this.job, 'cancelled');
      await this.job.completion;
    }
    await this.reader.stop();
  }
}
