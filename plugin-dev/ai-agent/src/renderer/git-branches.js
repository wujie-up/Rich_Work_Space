import { el, iconButton, modal } from './ui.js';
import './git-branches.css';

function branchFolders(branches) {
  const folders = new Map();
  for (const branch of branches) {
    let siblings = folders;
    const parts = branch.split('/');
    parts.forEach((name, index) => {
      if (!siblings.has(name)) {
        siblings.set(name, { name, path: parts.slice(0, index + 1).join('/'), children: new Map() });
      }
      const node = siblings.get(name);
      if (index === parts.length - 1) {
        node.branch = branch;
      }
      siblings = node.children;
    });
  }
  return folders;
}

function branchIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add(`git-branch-${kind}`);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', { folder: 'M3 7V4h7l2 3h9v13H3z', branch: 'M7 3v18 M7 14l10-7 M14 4h6v6',
    arrow: 'm9 5 7 7-7 7' }[kind]);
  svg.append(path);
  return svg;
}

function branchPicker(info, choose, previous) {
  const picker = el('div', { class: 'git-branches', role: 'group', 'aria-label': 'Git 分支' });
  picker.value = info.branches.includes(previous?.value) ? previous.value
    : info.branches.includes(info.branch) ? info.branch : info.branches[0] || '';
  const select = branch => {
    picker.value = branch;
    picker.querySelectorAll('[aria-pressed]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.branch === branch));
    });
  };
  const render = node => {
    if (node.branch) {
      return el('button', { type: 'button', class: 'git-branch-choice', 'data-branch': node.branch,
        title: node.branch, 'aria-label': `${node.branch}${node.branch === info.branch ? '（当前分支）' : ''}`,
        'aria-pressed': String(node.branch === picker.value), 'aria-haspopup': 'dialog', onclick: event => {
          select(node.branch);
          choose(node.branch, event.currentTarget);
        } },
      branchIcon('branch'), el('span', { class: 'git-branch-name', text: node.name }),
      node.branch === info.branch ? el('small', { class: 'muted', text: '当前' }) : null);
    }
    // Expand the selected branch's ancestors so the current location is visible immediately.
    const wasOpen = previous?.querySelector(`[data-path="${CSS.escape(node.path)}"]`)?.open;
    return el('details', { class: 'git-branch-group', 'data-path': node.path, open: wasOpen ?? picker.value.startsWith(`${node.path}/`) },
      el('summary', { title: node.path }, branchIcon('arrow'), branchIcon('folder'), el('span', { text: node.name })),
      el('div', { class: 'git-branch-children' }, ...[...node.children.values()].map(render)));
  };
  picker.append(...[...branchFolders(info.branches).values()].map(render));
  if (!info.branches.length) {
    picker.append(el('p', { class: 'muted', text: '暂无可切换的分支' }));
  }
  return picker;
}

// Keep the tree visible while confirming a branch beside its selected row.
export function showGitBranches(info, { switchBranch, refresh }, anchor) {
  return modal('切换 Git 分支', ({ body, actions, finish, dialog }) => {
    dialog.classList.add('git-branches-dialog');
    actions.remove();
    let branchDialog;
    const dismissBranch = () => branchDialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
    const choose = (branch, row) => {
      dismissBranch();
      modal('切换分支', ({ body, actions, finish: finishBranch, dialog: child }) => {
        branchDialog = child;
        child.classList.add('git-branch-action');
        body.append(el('p', { class: 'git-repository', text: `切换到 ${branch}？` }),
          el('p', { class: 'muted', text: '切换要求此工作树内所有会话均处于已识别的空闲状态。Git 冲突会直接报错，不覆盖本地修改。' }));
        const apply = iconButton('切换', 'check', async () => {
          apply.disabled = true;
          try {
            await switchBranch(branch);
            console.info('[git:branch-switched]', { root: info.root, branch });
            finishBranch(true);
            finish(true);
          } catch (error) {
            console.error('[git:branch-switch-failed]', { root: info.root, branch, stack: error.stack });
            throw error;
          } finally {
            apply.disabled = false;
          }
        }, 'primary');
        actions.append(iconButton('取消', 'close', () => finishBranch(null)), apply);
      }, { anchor: row });
    };
    let branches = branchPicker(info, choose);
    const current = el('p', { class: 'git-repository', text: info.detached ? '当前为分离 HEAD' : `当前分支：${info.branch}` });
    const refreshButton = iconButton('刷新分支', 'restore', async () => {
      refreshButton.disabled = true;
      refreshButton.setAttribute('aria-busy', 'true');
      dismissBranch();
      try {
        const next = await refresh();
        // The request may finish after the user closes this popup; never reopen it.
        if (!dialog.isConnected) {
          return;
        }
        const replacement = branchPicker(next, choose, branches);
        replacement.addEventListener('scroll', dismissBranch);
        const scrollTop = branches.scrollTop;
        branches.replaceWith(replacement);
        branches = replacement;
        branches.scrollTop = scrollTop;
        info = next;
        current.textContent = info.detached ? '当前为分离 HEAD' : `当前分支：${info.branch}`;
      } catch (error) {
        console.error('[git:branch-refresh-failed]', { root: info.root, stack: error.stack });
        throw error;
      } finally {
        refreshButton.disabled = false;
        refreshButton.removeAttribute('aria-busy');
      }
    });
    const heading = dialog.querySelector('.dialog-heading');
    heading.insertBefore(refreshButton, heading.lastElementChild);
    // A scrolled-away row must not leave its confirmation floating over unrelated branches.
    branches.addEventListener('scroll', dismissBranch);
    dialog.addEventListener('close', dismissBranch);
    body.append(el('p', { class: 'git-repository', text: info.root }),
      current, branches);
  }, { anchor });
}
