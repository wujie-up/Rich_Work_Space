// Hunk positions, rather than +/- file headers, determine source line numbers.
export function diffLines(text) {
  let before = 0;
  let after = 0;
  let hunk = false;
  return text.split('\n').filter((line, index, lines) => index < lines.length - 1 || line).map(text => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) {
      before = Number(match[1]);
      after = Number(match[2]);
      hunk = true;
      return { text, kind: 'hunk', before: '', after: '' };
    }
    if (!hunk || !/^[ +\-]/.test(text)) {
      return { text, kind: 'metadata', before: '', after: '' };
    }
    const kind = text.startsWith('+') ? 'added' : text.startsWith('-') ? 'removed' : 'context';
    return { text, kind, before: kind === 'added' ? '' : before++, after: kind === 'removed' ? '' : after++ };
  });
}

function renderFiles(result, loadFile) {
  const labels = { A: '新增', D: '删除', M: '修改', T: '类型变更' };
  let pending = Promise.resolve();
  return result.files.map(file => {
    const group = document.createElement('details');
    group.className = 'diff-file';
    group.open = true;
    const heading = document.createElement('summary');
    const badge = document.createElement('span');
    badge.className = `change-status change-${file.status}`;
    badge.textContent = labels[file.status] || file.status;
    heading.append(badge, document.createTextNode(file.path));
    const content = document.createElement('div');
    content.className = 'diff-content';
    let loading = false;
    // Queue expanded files so opening a category does not flood the plugin with Git requests.
    group.addEventListener('toggle', async () => {
      if (!group.open || content.childElementCount || loading) {
        return;
      }
      loading = true;
      content.textContent = '加载差异中…';
      try {
        const patch = pending.then(() => file.text !== undefined ? { text: file.text } : loadFile(file));
        pending = patch.catch(() => undefined);
        const { text } = await patch;
        content.replaceChildren(...diffLines(text).map(line => {
          const row = document.createElement('div');
          row.className = `diff-line ${line.kind}`;
          for (const value of [line.before, line.after, line.text]) {
            const cell = document.createElement('span');
            cell.textContent = String(value);
            row.append(cell);
          }
          return row;
        }));
      } catch (error) {
        content.textContent = `加载差异失败：${error.message}；收起后展开可重试`;
        console.error('[code-browser:diff]', { base: result.base, target: result.target, path: file.path, error });
      } finally {
        loading = false;
      }
    });
    group.append(heading, content);
    return group;
  });
}

// Keep category DOM after switching so file collapse state and loaded patches survive.
export function renderDiff(result, loadFile) {
  const tabs = document.createElement('div');
  tabs.className = 'diff-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '变更类型');
  const panels = [];
  const buttons = [];
  for (const [category, label] of [['A', '新增'], ['M', '修改'], ['D', '删除']]) {
    const files = result.files.filter(file => (['A', 'D'].includes(file.status) ? file.status : 'M') === category);
    const panel = document.createElement('div');
    panel.id = `diff-panel-${category}`;
    panel.className = 'diff-category';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `diff-tab-${category}`);
    panel.hidden = true;
    const button = document.createElement('button');
    button.id = `diff-tab-${category}`;
    button.textContent = `${label} (${files.length})`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    button.onclick = () => {
      buttons.forEach(tab => {
        tab.setAttribute('aria-selected', String(tab === button));
        tab.tabIndex = tab === button ? 0 : -1;
      });
      panels.forEach(item => { item.hidden = item !== panel; });
      if (!panel.childNodes.length) {
        panel.append(...renderFiles({ ...result, files }, loadFile));
        if (!files.length) {
          panel.textContent = `没有${label}文件`;
        }
      }
    };
    button.onkeydown = event => {
      const offset = { ArrowLeft: -1, ArrowRight: 1, Home: -buttons.indexOf(button), End: buttons.length - 1 - buttons.indexOf(button) }[event.key];
      if (offset !== undefined) {
        event.preventDefault();
        const next = buttons[(buttons.indexOf(button) + offset + buttons.length) % buttons.length];
        next.click();
        next.focus();
      }
    };
    buttons.push(button);
    panels.push(panel);
    tabs.append(button);
  }
  buttons[0].click();
  return [tabs, ...panels];
}
