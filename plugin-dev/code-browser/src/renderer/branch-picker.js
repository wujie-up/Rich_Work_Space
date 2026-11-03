import { showSideDialog, closeSideDialog } from './side-dialog.js';
import { invoke } from './api.js';
import { branchGroup } from './branch-tree.js';

export async function chooseBranch(value, title, side) {
  const { branches } = await invoke('branches');
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'branch-dialog';
    dialog.setAttribute('aria-label', title);
    const body = document.createElement('div');
    body.className = 'dialog-body';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const tree = document.createElement('div');
    tree.className = 'branch-tree';
    const finish = selected => { closeSideDialog(dialog); dialog.remove(); resolve(selected); };
    const option = (label, revision, container) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = revision;
      button.setAttribute('aria-pressed', String(value === revision));
      button.onclick = () => finish({ value: revision, label });
      container.append(button);
    };
    for (const [label, revision] of (side === 'base' ? [['HEAD', 'HEAD']] : [['HEAD', 'HEAD'], ['工作区', 'WORKTREE'], ['暂存区', 'INDEX']])) {
      option(label, revision, tree);
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = '搜索分支';
    search.setAttribute('aria-label', search.placeholder);
    const groups = document.createElement('div');
    const render = () => {
      groups.replaceChildren();
      const query = search.value.trim().toLowerCase();
      for (const [remote, label] of [[false, '本地分支'], [true, '远程分支']]) {
        groups.append(branchGroup(label, branches.filter(branch => branch.revision.startsWith('refs/remotes/') === remote
          && branch.name.toLowerCase().includes(query)), {
          selected: value, open: true,
          onSelect: branch => finish({ value: branch.revision, label: branch.name })
        }));
      }
    };
    search.oninput = render;
    tree.append(groups);
    render();
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    const close = document.createElement('button');
    close.className = 'icon-button';
    close.title = '关闭分支选择';
    close.setAttribute('aria-label', close.title);
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
    close.onclick = () => finish(null);
    body.append(heading, search, tree, close);
    dialog.append(body);
    document.body.append(dialog);
    showSideDialog(dialog);
  });
}
