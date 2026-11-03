import { showSideDialog, closeSideDialog } from './side-dialog.js';
import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import { invoke } from './api.js';
import { gitActions } from '../main/common/git-actions.js';
import { renderBranchMenu, branchName } from './branch-menu.js';

const icon = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${path}"/></svg>`;
const play = icon('m8 4 12 8-12 8Z');
const stop = icon('M5 5h14v14H5Z');
const refresh = icon('M20 10a8 8 0 1 0-1 7M20 4v6h-6');
const fields = {
  branch: ['分支 / 远程来源分支', 'input'], localBranch: ['本地目标分支（留空为当前分支）', 'input'], newBranch: ['新分支名', 'input'], revision: ['分支 / 提交', 'input'],
  remote: ['远程仓库', 'select'], message: ['提交 / 储藏说明', 'textarea'],
  all: ['全部文件', 'checkbox'], includeUntracked: ['包含未跟踪文件', 'checkbox'],
  mode: ['重置方式', 'select'], pullMode: ['拉取方式', 'select'], mainline: ['主线父提交编号（合并提交撤销）', 'number'],
  stash: ['储藏', 'select']
};

// Confirm exact targets in a native dialog; sandbox frames cannot use window.confirm.
function confirmOperation(input, root, anchor) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    const body = document.createElement('div');
    body.className = 'dialog-body';
    const detail = document.createElement('pre');
    detail.textContent = `${root}\n${gitActions[input.action].title}\n${JSON.stringify(input, null, 2)}\n${
      input.mode === 'hard' ? 'hard 重置会永久丢弃已跟踪文件的本地修改。' : gitActions[input.action].danger || '将执行 Git 操作，可能运行项目钩子或访问远程仓库。'}`;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const finish = value => { closeSideDialog(dialog); dialog.remove(); resolve(value); };
    for (const [label, image, value] of [['取消操作', stop, false], ['确认执行 Git 操作', play, true]]) {
      const button = document.createElement('button');
      button.className = 'icon-button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = image;
      button.onclick = () => finish(value);
      actions.append(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    body.append(detail, actions);
    dialog.append(body);
    document.body.append(dialog);
    showSideDialog(dialog, anchor);
  });
}

export function setupGitManagement(onChanged, onBefore = async () => true, onStatus = () => {}) {
  const panel = document.querySelector('#git-management');
  panel.innerHTML = `<div class="git-toolbar">
    <button id="git-new" class="icon-button" title="新建分支" aria-label="新建分支">${icon('M12 5v14M5 12h14')}</button>
    <button id="git-push" class="icon-button" title="推送当前分支" aria-label="推送当前分支">${icon('M5 19 19 5M5 5h14v14')}</button>
    <button id="git-pull" class="icon-button" title="更新当前分支" aria-label="更新当前分支">${icon('M19 5 5 19M5 5v14h14')}</button><button id="git-commit" class="icon-button" title="提交" aria-label="提交">${icon("M3 12h5m8 0h5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0")}</button></div>
    <dialog id="git-branches" aria-label="Git 分支列表"></dialog>
    <dialog id="git-commands" aria-label="提交更改"><div class="dialog-body git-management-body">
    <div class="git-command"><button id="git-close" class="icon-button" title="关闭 Git 操作" aria-label="关闭 Git 操作">${icon('m6 6 12 12M6 18 18 6')}</button><input id="git-action" type="hidden" value="commit">
      <button id="git-run" class="icon-button" title="执行 Git 操作" aria-label="执行 Git 操作">${play}</button>
      <button id="git-stop" class="icon-button" title="停止 Git 任务" aria-label="停止 Git 任务" disabled>${stop}</button>
      <button id="git-refresh" class="icon-button" title="刷新 Git 状态" aria-label="刷新 Git 状态">${refresh}</button></div>
    <button id="git-stage" class="icon-button" title="暂存选中文件" aria-label="暂存选中文件">${icon("M12 5v14M5 12h14")}</button><div id="git-fields" class="git-command"></div><p id="git-repository"></p>
    <div class="git-lists"><div id="git-files" aria-label="Git 工作区文件"></div></div>
    <p id="git-state" role="status" aria-live="polite"></p><pre id="git-log" aria-label="Git 操作日志"></pre></div></dialog>`;
  const $ = id => panel.querySelector(`#git-${id}`);
  const branchEntry = document.querySelector('#git-tab');
  $('close').onclick = () => closeSideDialog($('commands'));
  let repository;
  let task;
  let pending = false;
  const lifecycle = pageLifecycle();
  const controls = {};
  for (const [name, [title, type]] of Object.entries(fields)) {
    const label = document.createElement('label');
    label.textContent = title;
    const control = document.createElement(['select', 'textarea'].includes(type) ? type : 'input');
    if (['checkbox', 'number'].includes(type)) {
      control.type = type;
    }
    control.id = `git-field-${name}`;
    control.setAttribute('aria-label', title);
    if (type === 'input' || type === 'textarea') {
      control.maxLength = type === 'textarea' ? 4000 : 200;
    }
    label.append(control);
    $('fields').append(label);
    controls[name] = control;
  }
  controls.mode.replaceChildren(...['soft', 'mixed', 'hard'].map(value => new Option(value, value)));
  controls.pullMode.replaceChildren(...['ff-only', 'merge', 'rebase'].map(value => new Option(value, value)));

  function update() {
    const action = $('action').value;
    for (const [name, control] of Object.entries(controls)) {
      control.parentElement.hidden = !gitActions[action].fields.includes(name);
    }
    for (const control of panel.querySelectorAll('input,select,textarea,button')) {
      if (!control.closest('#git-branches')) {
        control.disabled = pending || task?.state === 'running';
      }
    }
    $('branches').inert = pending || task?.state === 'running';
    branchEntry.disabled = pending;
    $('close').disabled = false;
    $('stop').disabled = pending || task?.state !== 'running';
    $('stage').hidden = action !== 'commit' && action !== 'stage';
    if (action === 'push') {
      controls.remote.parentElement.hidden = true;
      controls.localBranch.parentElement.hidden = true;
    }
    $('run').title = $('run').ariaLabel = gitActions[action].title;
  }
  const error = reason => {
    onStatus(reason.message, true);
    $('state').textContent = reason.message;
    $('state').classList.add('error');
    console.error('[code-browser:git]', { root: repository?.root, error: reason });
    if (!repository) {
      branchEntry.textContent = '分支不可用';
      branchEntry.title = reason.message;
    }
  };
  async function readStatus() {
    repository = await invoke('gitStatus');
    if (!task) {
      $('state').textContent = '';
      $('state').classList.remove('error');
    }
    $('repository').textContent = `${repository.root} · 当前分支：${repository.current || '分离 HEAD'}${repository.operation ? ` · 待完成：${repository.operation}（外部解决冲突后暂存，再继续或中止）` : ''}`;
    branchEntry.textContent = repository.current || '分离 HEAD';
    branchEntry.title = branchEntry.ariaLabel = `当前分支：${branchEntry.textContent}，点击选择分支`;
    $('files').replaceChildren(...repository.files.map(file => {
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = file.path;
      const names = { A: '新增', D: '删除', M: '修改', R: '重命名', C: '复制', '?': '未跟踪', ' ': '无' };
      label.append(check, document.createTextNode(`${file.conflict ? '冲突' : `暂存：${names[file.index] || file.index} / 工作区：${names[file.worktree] || file.worktree}`} · ${file.path}`));
      return label;
    }));
    if (!repository.files.length) {
      $('files').textContent = '工作区干净';
    }
    const selectedRemote = controls.remote.value;
    controls.remote.replaceChildren(...repository.remotes.map(name => new Option(name, name)));
    controls.remote.value = repository.remotes.includes(selectedRemote) ? selectedRemote
      : repository.branches.find(branch => branch.current)?.upstreamRemote || repository.remotes[0] || '';
    controls.stash.replaceChildren(...repository.stashes.map(item => new Option(`${item.ref} · ${item.subject}`, item.ref)));
    const viewState = await invoke('viewState');
    const key = JSON.stringify(['branches', repository.root]);
    const preferences = { favorites: [], expanded: {}, ...viewState[key] };
    preferences.saveExpanded = () => {
      void invoke('viewState', { key, value: { expanded: preferences.expanded, favorites: preferences.favorites } }).catch(reason => {
        console.error('[code-browser:branch-expansion]', { root: repository.root, error: reason });
        error(reason);
      });
    };
    preferences.toggleFavorite = async revision => {
      const favorites = preferences.favorites.includes(revision)
        ? preferences.favorites.filter(value => value !== revision) : [...preferences.favorites, revision];
      await invoke('viewState', { key, value: { expanded: preferences.expanded, favorites } });
      preferences.favorites = favorites;
    };
    renderBranchMenu($('branches'), repository, selected => selectOperation(selected), preferences);
    update();
  }
  async function readTask() {
    task = (await invoke('gitTask')).task;
    if (task) {
      $('state').textContent = `${gitActions[task.action]?.title || task.action}：${task.state}${task.error ? ` · ${task.error}` : ''}`;
      $('state').classList.toggle('error', ['failed', 'conflicted'].includes(task.state));
      onStatus($('state').textContent, ['failed', 'conflicted'].includes(task.state));
      $('log').textContent = task.log || '';
    }
    update();
  }
  async function poll() {
    const previous = task?.state;
    await readTask();
    if (previous === 'running' && task?.state !== 'running') {
      await readStatus();
      await onChanged();
    }
  }
  async function reload() {
    try {
      const previous = task?.state;
      await readTask();
      await readStatus();
      if (previous === 'running' && task?.state !== 'running') {
        await onChanged();
      }
    } catch (reason) {
      error(reason);
    }
  }
  $('action').onchange = update;
  $('refresh').onclick = reload;
  async function selectOperation(selected, anchor = branchEntry) {
    try {
      if (!repository || (['pull', 'push'].includes(selected?.action) && !selected.values.localBranch)) {
        await readStatus();
      }
      if (selected && ['pull', 'push'].includes(selected.action) && !selected.values.localBranch) {
        const current = repository.branches.find(branch => branch.current);
        selected.values = { ...selected.values, remote: current?.upstreamRemote || repository.remotes[0] || '',
          localBranch: repository.current, branch: current?.upstreamRef?.replace(/^refs\/heads\//, '') || repository.current };
      }
      if (!selected) {
        return;
      }
      if (selected.compare) {
        closeSideDialog($('branches'));
        document.dispatchEvent(new CustomEvent('coding:compare', { detail: selected.compare }));
        return;
      }
      if (selected.edit) {
        const name = await branchName(selected.label, selected.action === 'renameBranch' ? selected.values.branch : '', anchor);
        if (!name) {
          return;
        }
        selected.values[selected.edit] = name;
      }
      $('action').value = selected.action;
      for (const name of gitActions[selected.action].fields) {
        if (controls[name] && controls[name].type !== 'checkbox') {
          controls[name].value = selected.values[name] || '';
        }
      }
      closeSideDialog($('branches'));
      update();
      if (selected.action === 'push') {
        await openPush(anchor);
        return;
      }
      await execute(anchor);
    } catch (reason) {
      error(reason);
    }
  }
  // Opening the branch list must not change the editor or the right-side tool panel.
  async function openBranches(anchor) {
    if ($('branches').matches(':popover-open')) {
      closeSideDialog($('branches'));
      return;
    }
    await reload();
    showSideDialog($('branches'), anchor);
    $('branches').querySelector('input')?.focus();
  }
  $('branches').addEventListener('toggle', event => {
    branchEntry.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  branchEntry.onclick = () => openBranches(branchEntry);
  $('commit').onclick = async () => {
    await reload();
    $('commands').ariaLabel = '提交更改';
    $('files').ariaLabel = 'Git 工作区文件';
    $('action').value = 'commit';
    update();
    showSideDialog($('commands'), $('commit'));
  };
  $('stage').onclick = async () => {
    $('action').value = 'stage';
    await execute($('stage'));
    $('action').value = 'commit';
    update();
  };
  for (const [id, action] of [['new', 'createBranch'], ['push', 'push'], ['pull', 'pull']]) {
    $(id).onclick = () => selectOperation({ action, label: '新建分支', edit: id === 'new' ? 'newBranch' : undefined,
      values: { revision: 'HEAD', pullMode: 'ff-only' } }, $(id));
  }

  async function openPush(anchor) {
    const preview = await invoke('gitPushPreview', { remote: controls.remote.value, localBranch: controls.localBranch.value });
    $('commands').ariaLabel = '推送更改';
    $('repository').textContent = `${preview.source} → ${preview.destination} · 按本地远程跟踪记录展示待推送文件`;
    $('files').ariaLabel = 'Git 待推送文件';
    $('files').replaceChildren(...preview.files.map(file => {
      const row = document.createElement('p');
      row.textContent = `${({ A: '新增', M: '修改', D: '删除', T: '修改' })[file.status] || file.status} · ${file.path}`;
      return row;
    }));
    if (!preview.files.length) {
      $('files').textContent = '没有文件内容变化（仍可推送提交记录）';
    }
    showSideDialog($('commands'), anchor);
  }

  async function execute(anchor) {
    if (pending || task?.state === 'running') {
      return;
    }
    pending = true;
    update();
    try {
      const action = $('action').value;
      const input = { action };
      for (const name of gitActions[action].fields) {
        if (name === 'paths') {
          input.paths = [...$('files').querySelectorAll('input:checked')].map(control => control.value);
        } else if (controls[name].type === 'checkbox') {
          input[name] = controls[name].checked;
        } else if (controls[name].value) {
          input[name] = name === 'mainline' ? Number(controls[name].value) : controls[name].value;
        }
      }
      if (!repository) {
        await readStatus();
      }
      if (action === 'commit' && !input.message?.trim()) {
        error(new Error('请填写提交备注'));
        return;
      }
      const dangerous = gitActions[action].danger || action === 'reset' && input.mode === 'hard';
      if ((!dangerous || await confirmOperation(input, repository.root, anchor)) && await onBefore()) {
        task = (await invoke('gitOperation', { ...input, confirmed: true })).task;
        await readTask();
        if (task.state !== 'running') {
          await readStatus();
          await onChanged();
        }
      }
    } catch (reason) {
      error(reason);
    } finally {
      pending = false;
      update();
      if ($('action').value === 'commit' && !controls.message.value.trim()) {
        controls.message.focus();
      }
    }
  }
  $('run').onclick = () => execute($('run'));
  $('stop').onclick = async () => {
    try {
      await invoke('cancelGit', { id: task.id });
      await reload();
    } catch (reason) {
      error(reason);
    }
  };
  document.addEventListener('coding:tool', event => {
    if (event.detail === 'git') {
      void reload();
    }
  });
  pollVisible(lifecycle, async () => {
    if (task?.state === 'running') {
      await poll();
    }
  }, 1000, { onError: error });
  void readTask().catch(error);
  document.addEventListener('coding:workspace', () => {
    repository = undefined;
    task = undefined;
    closeSideDialog($('branches'));
    branchEntry.textContent = '读取分支…';
    branchEntry.title = '选择 Git 分支';
    $('files').replaceChildren();
    $('branches').replaceChildren();
    $('log').textContent = '';
    $('repository').textContent = '';
    update();
    void reload();
  });
  update();
}
