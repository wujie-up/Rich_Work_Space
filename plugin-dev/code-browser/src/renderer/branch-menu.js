import { showSideDialog, closeSideDialog } from './side-dialog.js';
import { branchGroup, branchIcon } from './branch-tree.js';

const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';

function menuItem(label, choose, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  button.title = label;
  button.disabled = disabled;
  button.onclick = choose;
  return button;
}

function branchOperations(repository, branch) {
  const current = repository.current;
  const remote = branch.upstreamRemote || repository.remotes[0] || '';
  const target = branch.revision;
  return [
    { label: `与当前分支 '${current || 'HEAD'}' 比较`, compare: { base: target, target: 'HEAD' }, disabled: branch.current },
    { label: '签出', action: 'switch', values: { branch: target }, disabled: branch.current },
    { label: `从 '${branch.name}' 新建分支…`, action: 'createBranch', values: { revision: target }, edit: 'newBranch' },
    { label: '显示与工作树的差异', compare: { base: target, target: 'WORKTREE' } },
    { label: `将当前分支 '${current || 'HEAD'}' 变基到 '${branch.name}'`, action: 'rebase', values: { revision: target }, disabled: !current || branch.current },
    { label: `将 '${branch.name}' 合并到当前分支 '${current || 'HEAD'}'`, action: 'merge', values: { revision: target }, disabled: !current || branch.current },
    { label: '更新', action: 'pull', values: { remote, branch: branch.upstreamRef?.replace(/^refs\/heads\//, '') || branch.name, localBranch: branch.name, pullMode: 'ff-only' }, disabled: branch.remote || !remote },
    { label: '推送…', action: 'push', values: { remote, localBranch: branch.name }, disabled: branch.remote || !remote },
    { label: '重命名…', action: 'renameBranch', values: { branch: branch.name }, edit: 'newBranch', disabled: branch.remote },
    { label: '删除', action: 'deleteBranch', values: { branch: branch.name }, disabled: branch.remote || branch.current }
  ];
}

export function renderBranchMenu(container, repository, choose, preferences) {
  const dialog = document.createElement('div');
  dialog.className = 'branch-browser';
  dialog.setAttribute('aria-label', 'Git 分支和操作');
  const body = document.createElement('div');
  body.className = 'branch-menu-body';
  const header = document.createElement('div');
  header.className = 'branch-menu-header';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索分支和操作';
  search.setAttribute('aria-label', search.placeholder);
  const tree = document.createElement('div');
  tree.className = 'branch-tree';
  const finish = value => {
    dialog.querySelector('.branch-actions-dialog')?.remove();
    choose(value);
  };
  function showActions(branch, button) {
    const current = dialog.querySelector('.branch-actions-dialog');
    if (button.getAttribute('aria-expanded') === 'true' && current?.matches(':popover-open')) {
      return current;
    }
    current?.remove();
    tree.querySelectorAll('.branch-entry').forEach(entry => entry.setAttribute('aria-expanded', String(entry === button)));
    return openBranchActions(repository, branch, dialog, button, finish);
  }
  function chooseBranch(branch, button) {
    showActions(branch, button).querySelector('.branch-operations button:not(:disabled)')?.focus();
  }
  // Search expansion survives favorite refreshes and resets only when the query changes.
  let searchExpanded = {};
  function render() {
    dialog.querySelector('.branch-actions-dialog')?.remove();
    const query = search.value.trim().toLowerCase();
    const branches = repository.branches.filter(branch => `${branch.name} ${branch.upstream || ''}`.toLowerCase().includes(query));
    tree.replaceChildren();
    const groups = [
      ['收藏', branches.filter(branch => preferences.favorites.includes(branch.revision))],
      ['最近', (repository.recent || []).flatMap(name => branches.filter(branch => branch.name === name))],
      ['本地', branches.filter(branch => !branch.remote)],
      ['远程', branches.filter(branch => branch.remote)]
    ];
    for (const [label, entries] of groups) {
      if (entries.length || label === '收藏') {
        tree.append(branchGroup(label, entries, { selected: repository.branches.find(branch => branch.current)?.revision,
          onSelect: chooseBranch, onHover: showActions, open: Boolean(query),
          expanded: query ? searchExpanded : preferences.expanded, onToggle: query ? undefined : preferences.saveExpanded,
          favorites: preferences.favorites, onFavorite: async branch => {
            try {
              await preferences.toggleFavorite(branch.revision);
              render();
            } catch (error) {
              console.error('[code-browser:favorite]', { root: repository.root, revision: branch.revision, error });
              document.querySelector('#git-state').textContent = error.message;
            }
          } }));
      }
    }
    if (!branches.length) {
      const empty = document.createElement('p');
      empty.textContent = '无匹配的分支或操作';
      tree.append(empty);
    }
  }
  dialog.onkeydown = event => moveMenuFocus(event, tree, search);
  search.oninput = () => {
    searchExpanded = {};
    render();
  };
  header.append(search);
  body.append(header, tree);
  dialog.append(body);
  search.value = container.querySelector('input')?.value || '';
  container.replaceChildren(dialog);
  render();
}

// Keep the branch list interactive while the selected row opens its adjacent action menu.
function openBranchActions(repository, branch, parent, anchor, choose) {
  const dialog = document.createElement('dialog');
  dialog.className = 'branch-actions-dialog context-menu';
  dialog.setAttribute('aria-label', `分支操作：${branch.name}`);
  const body = document.createElement('div');
  body.className = 'branch-menu-body';
  const close = document.createElement('button');
  close.className = 'icon-button';
  close.title = close.ariaLabel = '返回分支列表';
  close.innerHTML = closeIcon;
  const title = document.createElement('strong');
  title.textContent = branch.name;
  const header = document.createElement('div');
  header.className = 'branch-menu-header';
  header.append(title, close);
  const actions = document.createElement('div');
  actions.className = 'branch-operations';
  actions.setAttribute('role', 'menu');
  actions.setAttribute('aria-label', '分支操作');
  for (const operation of branchOperations(repository, branch)) {
    actions.append(menuItem(operation.label, () => choose(operation), operation.disabled));
  }
  close.onclick = () => {
    dialog.remove();
    anchor.setAttribute('aria-expanded', 'false');
    anchor.focus();
  };
  dialog.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      close.click();
      return;
    }
    moveMenuFocus(event, actions);
  };
  body.append(header, actions);
  dialog.append(body);
  parent.append(dialog);
  dialog.oncancel = event => { event.preventDefault(); close.click(); };
  showSideDialog(dialog, anchor);
  return dialog;
}

// Keep native Tab navigation and allow arrows to traverse only visible, enabled menu rows.
function moveMenuFocus(event, container, search) {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target === search) {
    return;
  }
  const buttons = [...container.querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length);
  const index = buttons.indexOf(document.activeElement);
  const next = event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : (index + 1) % buttons.length;
  buttons[next]?.focus();
  event.preventDefault();
}

// Ellipsis actions collect their required name before entering the existing Git confirmation flow.
export function branchName(title, initial = '', anchor) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', title);
    const body = document.createElement('div');
    body.className = 'dialog-body branch-name';
    const label = document.createElement('label');
    label.textContent = title;
    const input = document.createElement('input');
    input.setAttribute('aria-label', '分支名称');
    input.maxLength = 200;
    input.value = initial;
    label.append(input);
    const finish = value => { closeSideDialog(dialog); dialog.remove(); resolve(value); };
    const accept = document.createElement('button');
    accept.className = 'icon-button';
    accept.title = accept.ariaLabel = '确认分支名称';
    accept.innerHTML = branchIcon('current');
    const submit = () => {
      if (input.value.trim()) {
        finish(input.value.trim());
      }
    };
    accept.onclick = submit;
    const cancel = document.createElement('button');
    cancel.className = 'icon-button';
    cancel.title = cancel.ariaLabel = '取消分支操作';
    cancel.innerHTML = closeIcon;
    cancel.onclick = () => finish(null);
    input.onkeydown = event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    };
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    body.append(label, cancel, accept);
    dialog.append(body);
    document.body.append(dialog);
    showSideDialog(dialog, anchor);
    input.select();
  });
}
