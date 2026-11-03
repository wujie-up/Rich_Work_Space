const paths = {
  folder: 'M3 6h7l2 3h9v11H3Z',
  branch: 'M6 3v12a4 4 0 0 0 8 0V9M3 6h6M11 6h6',
  current: 'm5 12 4 4L19 6',
  chevron: 'm9 5 7 7-7 7',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z'
};

export const branchIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${paths[name]}"/></svg>`;

// Construct labels with textContent because branch names are repository-controlled input.
export function branchGroup(label, branches, { selected, onSelect, onHover, open = false, expanded = {}, onToggle, favorites, onFavorite }) {
  const group = document.createElement('details');
  const trackExpansion = (details, key) => {
    details.open = expanded[key] ?? open;
    details.addEventListener('toggle', () => {
      if (details.isConnected && expanded[key] !== details.open) {
        expanded[key] = details.open;
        onToggle?.();
      }
    });
  };
  trackExpansion(group, label);
  const summary = document.createElement('summary');
  summary.textContent = label;
  group.append(summary);
  const folders = new Map();
  for (const branch of branches) {
    const parts = branch.name.split('/');
    let parent = group;
    let prefix = '';
    for (const part of parts.slice(0, -1)) {
      prefix += `/${part}`;
      if (!folders.has(prefix)) {
        const folder = document.createElement('details');
        trackExpansion(folder, `${label}${prefix}`);
        const title = document.createElement('summary');
        title.innerHTML = branchIcon('folder');
        title.append(document.createTextNode(part));
        folder.append(title);
        parent.append(folder);
        folders.set(prefix, folder);
      }
      parent = folders.get(prefix);
    }
    const button = document.createElement('button');
    button.className = 'branch-entry';
    button.title = branch.revision;
    button.setAttribute('aria-pressed', String(branch.revision === selected));
    button.innerHTML = branchIcon(branch.current ? 'current' : 'branch');
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = parts.at(-1);
    const upstream = document.createElement('span');
    upstream.className = 'branch-upstream truncate';
    upstream.textContent = branch.current ? `当前${branch.upstream ? ` · ${branch.upstream}` : ''}` : branch.upstream || '';
    button.append(name, upstream);
    button.insertAdjacentHTML('beforeend', branchIcon('chevron'));
    button.onclick = () => onSelect(branch, button);
    if (onHover) {
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.onpointerenter = event => {
        if (event.pointerType === 'mouse') {
          onHover(branch, button);
        }
      };
    }
    button.onkeydown = event => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onSelect(branch, button);
      }
    };
    const row = document.createElement('div');
    row.className = 'branch-row';
    row.append(button);
    if (onFavorite) {
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'branch-favorite icon-button';
      const favorite = favorites.includes(branch.revision);
      star.setAttribute('aria-pressed', String(favorite));
      star.title = star.ariaLabel = `${favorite ? '取消收藏' : '收藏'} ${branch.name}`;
      star.innerHTML = branchIcon('star');
      star.onclick = () => onFavorite(branch);
      row.append(star);
    }
    parent.append(row);
  }
  return group;
}
