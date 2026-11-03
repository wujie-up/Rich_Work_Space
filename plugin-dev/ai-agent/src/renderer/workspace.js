import { sessionDisplay } from './session-display.js';
import { showRestoreProgress } from './restore-progress.js';
import { api, el, iconButton, setButtonIcon, field, modal, ask, confirm, toast } from './ui.js';
import { mountTerminal } from './terminal.js';
import { showHistory } from './history.js';
import { conversationApi } from './api.js';
import { sessionArrangement } from './session-arrangement.js';
import { showRoles } from './settings-roles.js';
import { closePopup } from '../../../../desk/src/resource/popup.js';
import { showSettings } from './settings-dialog.js';
import { closeSession } from './session-close.js';
import { sessionStatus } from './session-status.js';
import { recoverSessions, restoreWhenReady } from './session-recovery.js';
import { showGitBranches } from './git-branches.js';
import { sessionQuestion } from './session-question.js';
import { sessionConnection } from './session-connection.js';
import { groupSidebar } from './group-sidebar.js';
import { roleCatalog } from '../shared/agent-roles.js';
import { showNavigationMenu, groupNavigation, createSessionGroup, assignSessionGroup, addSessionToGroup, renameSessionGroup, deleteSessionGroup, archiveSessionGroup } from './session-groups.js';

const statusText = { idle: '等待输入', working: '运行中', done: '本轮完成', error: '本轮异常', unknown: '状态不可识别' };
const blockedText = { permission: '等待授权', question: '等待用户确认', auth: '等待登录' };

function setCollapsed(card, collapsed) {
  card.node.classList.toggle('collapsed', collapsed);
  card.collapseButton.setAttribute('aria-expanded', String(!collapsed));
  card.collapseButton.setAttribute('aria-label', collapsed ? '展开' : '折叠');
  card.collapseButton.title = collapsed ? '展开' : '折叠';
}

// The overlay retains normal dimensions and the collapsed state used when returning to normal size.
function setMaximized(card, maximized, collapsed) {
  card.node.classList.toggle('maximized', maximized);
  setCollapsed(card, !maximized && collapsed);
  card.collapseButton.disabled = maximized;
  setButtonIcon(card.maximizeButton, maximized ? '恢复原大小' : '最大化', maximized ? 'normal' : 'maximize');
  card.maximizeButton.setAttribute('aria-pressed', String(maximized));
}

// Use the same compact action list and popup lifecycle as group navigation menus.
function workspaceTools(...actions) {
  const trigger = iconButton('工作台操作', 'more', () => {
    const current = document.querySelector('.workspace-menu:popover-open');
    if (current) {
      closePopup(current);
      return;
    }
    const menu = showNavigationMenu(trigger, '工作台操作', actions, 'workspace-menu');
    trigger.setAttribute('aria-expanded', 'true');
    menu.addEventListener('toggle', event => {
      if (event.newState === 'closed') { trigger.setAttribute('aria-expanded', 'false'); }
    });
  });
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'menu');
  // Let a second trigger click toggle the menu before outside-click dismissal runs.
  trigger.addEventListener('pointerdown', event => event.stopPropagation());
  return el('div', { class: 'workspace-tools' }, trigger);
}

export async function mountWorkspace(root, { pluginId, adapters }) {
  let disposed = false;
  let disconnected = navigator.onLine === false;
  const windowId = /^agent-window:[a-f0-9-]{36}$/.test(window.name) ? window.name.slice(13) : crypto.randomUUID();
  window.name = `agent-window:${windowId}`;
  const hostWindow = await api.host.getWindowContext();
  await conversationApi.call('conversation.registerWindow', { id: windowId, hostWindowId: hostWindow?.id });
  let layout = await api.storage.getLayout(pluginId);
  let config = await api.storage.getAdapterConfig(pluginId);
  layout = { order: [], sizes: {}, collapsed: [], maximized: [], ...layout };
  layout.concise ||= {};
  layout.activeGroup ||= '';
  layout.groupSidebar ||= {};
  layout.groupSidebar.expandedGroups ||= [layout.activeGroup];
  let snapshot = { groups: [], sessions: [] };
  const cards = new Map();
  // Fresh windows stay independent after the first view has recovered interrupted sessions.
  const selectedSessions = new URLSearchParams(location.search).has('fresh') ? new Set() : null;
  let saveTimer;
  let saving = Promise.resolve();
  const saveLayout = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    // The host rejects overlapping exclusive writes; keep the latest layout in a single view's save queue.
    saving = saving.then(async () => {
      try {
        await api.storage.saveLayout(pluginId, layout);
      } catch (error) {
        console.error('[session:layout-save-failed]', { pluginId, windowId }, error);
        if (!disposed) {
          toast(error.message);
        }
      }
    });
    return saving;
  };
  // Flush a final resize before teardown; explicit presentation changes are saved immediately.
  const flushLayout = () => {
    if (saveTimer) {
      void saveLayout();
    }
  };
  window.addEventListener('pagehide', flushLayout);
  window.addEventListener('pointerup', flushLayout);
  const windows = el('div', { class: 'windows arranged' });
  const arrangement = sessionArrangement(windows, layout, saveLayout, pluginId);
  const createGroup = () => createSessionGroup(pluginId, adapters, windowId, async result => {
    result.sessions.forEach(session => selectedSessions?.add(session.id));
    layout.activeGroup = result.group.id;
    layout.groupSidebar.expandedGroups.push(result.group.id);
    update(await api.sessions.list(pluginId));
    await saveLayout();
  });
  const navigation = groupNavigation({
    presentation: layout.groupSidebar, save: saveLayout,
    select: id => selectGroup(id),
    focus: id => focus(id),
    move: id => assignSessionGroup(pluginId, snapshot.sessions.find(session => session.id === id), snapshot.groups),
    rename: id => renameSessionGroup(pluginId, snapshot.groups.find(group => group.id === id)),
    archive: id => archiveSessionGroup(pluginId, snapshot.groups.find(group => group.id === id)),
    remove: id => deleteSessionGroup(pluginId, snapshot.groups.find(group => group.id === id)),
    add: id => addSessionToGroup(pluginId, snapshot.groups.find(group => group.id === id), windowId, focus)
  });
  const empty = el('div', { class: 'empty workspace-empty' }, el('img', { class: 'empty-symbol', src: '../../ico/icon.svg', alt: '' }),
    el('h2', { text: '为下一件事，打开一个会话' }), el('p', { text: '选择工作目录，让多个 Agent 各自专注。' }),
    iconButton('新建会话', 'create', () => createSession()));
  const sidebar = groupSidebar({ navigation: navigation.node, canvas: el('div', { class: 'group-canvas' }, windows, empty),
    presentation: layout.groupSidebar, save: saveLayout });
  const loading = root.querySelector('.workspace-loading') || el('div', { class: 'workspace-loading', role: 'status' });
  const toolbar = el('div', { class: 'page-heading group-toolbar' }, sidebar.toggleButton,
    workspaceTools({ label: '创建会话组', icon: 'group', perform: createGroup },
      { label: 'CLI 配置', icon: 'configure', perform: () => configure() },
      { label: '角色维护', icon: 'roles', perform: () => showRoles(pluginId) },
      { label: '历史', icon: 'history', perform: () => showHistory(pluginId, adapters, focus, windowId) },
      { label: '新建会话', icon: 'create', perform: () => createSession() }));
  root.setAttribute('aria-busy', 'true');
  toolbar.inert = sidebar.node.inert = true;
  empty.hidden = true;
  root.replaceChildren(loading, toolbar, sidebar.node);

  const focus = async (id) => {
    await api.sessions.attachWindow(pluginId, id, windowId);
    selectedSessions?.add(id);
    const data = await api.sessions.list(pluginId);
    layout.activeGroup = data.sessions.find(session => session.id === id)?.groupId || '';
    if (!layout.groupSidebar.expandedGroups.includes(layout.activeGroup)) { layout.groupSidebar.expandedGroups.push(layout.activeGroup); }
    update(data);
    const card = cards.get(id);
    layout.collapsed = layout.collapsed.filter((value) => value !== card?.node.dataset.layout);
    if (card) {
      setCollapsed(card, false);
      card.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.connection.focus();
      saveLayout();
    }
  };

  // Group navigation reuses running sessions without expanding or focusing individual cards.
  async function selectGroup(groupId) {
    try {
      const data = await api.sessions.list(pluginId);
      const members = data.sessions.filter(session => (session.groupId || '') === groupId);
      for (const session of members) {
        if (session.windowId !== windowId) {
          await api.sessions.attachWindow(pluginId, session.id, windowId);
        }
        selectedSessions?.add(session.id);
      }
      layout.activeGroup = groupId;
      update(await api.sessions.list(pluginId));
      await saveLayout();
      console.info('[session:group-selected]', { pluginId, windowId, groupId, members: members.length });
    } catch (error) {
      update(snapshot);
      console.error('[session:group-select-failed]', { pluginId, windowId, groupId }, error);
      throw error;
    }
  }

  async function configure() {
    await showSettings({ pluginId, adapters });
  }

  async function createSession() {
    const roles = roleCatalog(await api.storage.getRoles(pluginId)).items;
    config = await api.storage.getAdapterConfig(pluginId);
    await modal('新建 Agent 会话', ({ body, actions, finish }) => {
      const adapter = el('select', { name: 'adapter' }, ...adapters.map((a) => el('option', { value: a.id, text: a.name || a.id })));
      const name = el('input', { name: 'sessionName', value: `Agent ${cards.size + 1}`, maxlength: 60, required: true });
      const cwd = el('input', { name: 'cwd', value: config.lastCwd || '', placeholder: '/Users/你的名字/项目', required: true });
      const role = el('select', { name: 'agentRole' }, el('option', { value: '', text: '不指定角色' }),
        ...roles.map(item => el('option', { value: item.id, text: item.name })));
      const roleField = field('Agent 角色', role);
      const permission = el('select', { name: 'permission' });
      const permissionField = field('权限模式', permission);
      const permissionDescription = el('small', { id: 'permission-description', class: 'muted' });
      permission.setAttribute('aria-describedby', 'permission-description');
      permissionField.append(permissionDescription);
      const describePermission = () => {
        permissionDescription.textContent = permission.selectedOptions[0]?.dataset.description || '';
      };
      permission.addEventListener('change', describePermission);
      const update = () => {
        const selected = adapters.find((a) => a.id === adapter.value);
        permission.replaceChildren(...(selected.permissionModes || []).map((mode) => el('option', {
          value: mode.id || mode, text: mode.label || mode, 'data-description': mode.description || ''
        })));
        describePermission();
        permissionField.hidden = !selected.capabilities.permissions;
        roleField.hidden = !['codex', 'claude'].includes(selected.id);
      };
      adapter.addEventListener('change', update);
      update();
      body.append(field('Agent', adapter), field('会话名称', name), roleField, field('工作目录', el('div', { class: 'input-row' }, cwd,
        iconButton('选择…', 'folder', async () => { const path = await api.host.chooseDirectory({ defaultPath: cwd.value.trim() }); if (path) { cwd.value = path; } }))), permissionField);
      actions.append(iconButton('取消', 'close', () => finish(null)), iconButton('启动会话', 'play', async () => {
        if (!name.reportValidity() || !cwd.reportValidity()) {
          return;
        }
        config = await api.storage.getAdapterConfig(pluginId);
        const selected = adapters.find((a) => a.id === adapter.value);
        if (selected.id === 'custom' && !config.custom?.command) {
          throw Error('请先在“CLI 配置”中设置自定义 CLI 的可执行文件。');
        }
        const created = await api.sessions.create(pluginId, { adapterId: adapter.value, name: name.value, cwd: cwd.value, windowId,
          groupId: layout.activeGroup || undefined,
          agentRole: ['codex', 'claude'].includes(adapter.value) ? roles.find(item => item.id === role.value) : undefined,
          permission: selected.capabilities.permissions ? permission.value : 'default' });
        // Session creation can overlap another view's configuration dialog.
        config = await api.storage.getAdapterConfig(pluginId);
        config.lastCwd = cwd.value;
        await api.storage.saveAdapterConfig(pluginId, config);
        finish(true);
        await focus(created.id);
      }, 'primary'));
    }, { placement: 'center' });
  }

  async function showGit(session, anchor) {
    const info = await api.sessions.gitInfo(pluginId, session.id);
    if (!info) {
      throw Error('此工作目录不是 Git 仓库，或未找到 git。');
    }
    // Git discovery can outlive terminal focus changes; retain the clicked footer as the popup anchor.
    await showGitBranches(info, { switchBranch: branch => api.sessions.switchBranch(pluginId, session.id, branch),
      refresh: () => api.sessions.refreshGit(pluginId, session.id) }, anchor);
  }

  function makeCard(session) {
    // Runtime IDs change on resume; layout belongs to the stable history identity.
    const layoutId = session.restoredFrom || session.id;
    if (layoutId !== session.id) {
      for (const field of ['sizes', 'positions']) {
        if (layout[field]?.[session.id]) {
          layout[field][layoutId] = layout[field][session.id];
          delete layout[field][session.id];
        }
      }
      for (const field of ['order', 'collapsed', 'maximized']) {
        layout[field] = layout[field].map(id => id === session.id ? layoutId : id);
      }
    }
    const adapter = adapters.find((a) => a.id === session.adapterId);
    const protocol = adapter?.capabilities.inputProtocol || config[session.adapterId]?.inputProtocol;
    const heading = el('strong', { class: 'session-name', text: session.name });
    const activity = el('span', { class: 'activity' });
    const stateIcon = el('span', { class: 'session-status', role: 'img' });
    const branch = iconButton('Git', 'git', () => showGit(cards.get(session.id).session, branch), 'branch');
    const branchName = el('span', { class: 'branch-name' });
    branch.append(branchName);
    branch.setAttribute('aria-haspopup', 'dialog');
    const mount = el('div', { class: 'terminal-mount' });
    const rename = async () => {
      const name = await ask('重命名会话', cards.get(session.id).session.name);
      if (name) { await api.sessions.rename(pluginId, session.id, name); }
    };
    const collapse = () => {
      layout.collapsed = layout.collapsed.includes(layoutId) ? layout.collapsed.filter(id => id !== layoutId) : [...layout.collapsed, layoutId];
      setCollapsed(card, layout.collapsed.includes(layoutId));
      saveLayout();
    };
    const collapseButton = iconButton('折叠', 'collapse', collapse, 'collapse-toggle');
    const maximizeButton = iconButton('最大化', 'maximize', () => {
      try {
        const maximized = !card.node.classList.contains('maximized');
        setMaximized(card, maximized, layout.collapsed.includes(layoutId));
        arrangement.refresh();
        layout.maximized = layout.maximized.filter(id => ![...cards.values()].some(item => !item.node.hidden && item.node.dataset.layout === id));
        if (maximized) {
          layout.maximized.push(layoutId);
        }
        void saveLayout();
        console.info('[session:maximized]', { pluginId, sessionId: session.id, maximized });
      } catch (error) {
        console.error('[session:maximize-failed]', { pluginId, sessionId: session.id }, error);
        setMaximized(card, false, layout.collapsed.includes(layoutId));
        throw error;
      }
    });
    maximizeButton.setAttribute('aria-pressed', 'false');
    const retry = iconButton('重试', 'history', async () => {
      retry.disabled = true;
      try {
        const created = await restoreWhenReady(api.sessions, pluginId, session.id, windowId);
        await focus(created.id);
        const replacement = cards.get(created.id);
        replacement.connection.draft = card.connection.draft;
        replacement.connection.focus();
      } finally {
        retry.disabled = false;
      }
    });
    retry.hidden = !session.exited;
    const reconnect = iconButton('重新连接工具', 'restore', async () => {
      reconnect.disabled = true;
      try {
        const created = await api.sessions.reconnect(pluginId, session.id);
        await focus(created.id);
        toast('工具已重新连接，会话历史已保留');
      } finally {
        reconnect.disabled = false;
      }
    });
    reconnect.title = '空闲时重新连接工具并恢复上下文；请先提交或保存未发送的终端输入';
    reconnect.hidden = !['codex', 'claude'].includes(session.adapterId) || session.exited;
    const close = iconButton('关闭', 'close', async () => closeSession(pluginId, cards.get(session.id).session), 'quiet-danger');
    const actions = el('div', { class: 'card-actions' }, retry, reconnect, iconButton('改名', 'rename', rename), collapseButton, maximizeButton, close);
    const handle = el('span', { class: 'drag-handle', 'aria-hidden': 'true' });
    handle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5h1 M15 5h1 M8 12h1 M15 12h1 M8 19h1 M15 19h1"/></svg>';
    const caption = el('div', { class: 'session-caption' }, handle, heading, activity);
    const model = el('button', { class: 'session-model', type: 'button', hidden: true, 'aria-label': '切换模型',
      onclick: event => cards.get(session.id).terminal.switchModel(event.currentTarget) });
    const displayButton = el('button', { class: 'session-display-toggle', type: 'button' });
    const details = el('div', { class: 'session-header-details' }, model, actions);
    const header = el('div', { class: 'session-header' }, stateIcon, caption, details);
    const footer = el('div', { class: 'session-footer' }, branch, el('span', { class: 'cwd', text: session.cwd, title: session.cwd }));
    const interrupt = iconButton('中断', 'interrupt', () => card.terminal.interrupt(), 'input-helper');
    interrupt.title = '中断当前执行（Codex / Claude Code：Option+C 或 Ctrl+C）';
    footer.append(interrupt);
    const resetContext = iconButton('清理会话上下文', 'resetContext', async () => {
      resetContext.disabled = true;
      resetContext.setAttribute('aria-busy', 'true');
      try {
        const confirmed = await modal('清理当前会话上下文？', ({ body, actions, finish }) => {
          body.append(el('p', { text: `清除“${cards.get(session.id).session.name}”的引擎会话历史并启动空白会话，无法恢复。`
            + '未发送的输入也会丢弃，名称、工作目录及文件保持不变。' }));
          actions.append(iconButton('取消', 'close', () => finish(false)),
            iconButton('确认清理', 'check', () => finish(true), 'danger'));
        }, { anchor: resetContext });
        if (!confirmed) {
          return;
        }
        const created = await api.sessions.resetContext(pluginId, session.id);
        selectedSessions?.add(created.id);
        // Reuse the stable layout identity without expanding a collapsed session or changing maximization.
        update(await api.sessions.list(pluginId));
        const replacement = cards.get(created.id);
        if (replacement && !replacement.node.classList.contains('collapsed')) {
          replacement.terminal.focus();
        }
        toast('上下文已清理，已启动空白会话');
      } finally {
        resetContext.removeAttribute('aria-busy');
        update(await api.sessions.list(pluginId));
      }
    }, 'input-helper');
    footer.append(resetContext);
    const clear = iconButton('清空输入', 'clear', () => card.terminal.clear(), 'input-helper');
    const newline = iconButton('换行', 'newline', () => card.terminal.newline(), 'input-helper');
    newline.title = '换行（Shift+Enter）';
    const fork = iconButton('分叉', 'fork', async () => {
      const name = await ask('分叉上下文', `${cards.get(session.id).session.name} · 分叉`);
      if (name) {
        const created = await api.sessions.fork(pluginId, session.id, name);
        await focus(created.id);
      }
    }, 'input-helper');
    if (protocol === 'codex') { footer.append(clear, newline); }
    if (adapter?.capabilities.fork) { footer.append(fork); }
    footer.append(displayButton);
    const error = el('div', { class: 'session-error', hidden: true });
    const prompt = el('div', { class: 'native-confirmation', hidden: true, role: 'status', text: '需要你的确认 · 请在下方回复或选择' });
    const content = el('div', { class: 'session-content' }, prompt, mount);
    const node = el('article', { class: 'session', 'data-session': session.id, 'data-layout': layoutId }, header, content, error, footer);
    arrangement.bind(node, header);
    windows.append(node);
    let display;
    const terminal = mountTerminal(mount, { session, protocol, onComposerLayout: value => display?.composer(value), onModel: value => {
      model.textContent = value;
      model.title = `切换模型 · ${value}`;
      model.hidden = false;
    } });
    display = sessionDisplay(node, mount, session, displayButton, layout.concise[layoutId] === true, value => {
      layout.concise[layoutId] = value;
      void saveLayout();
    });
    const connection = sessionConnection(content, mount, pluginId, session.id, terminal);
    const observer = new ResizeObserver(() => {
      // Native drag resizing writes inline dimensions; keep its viewport so future host resizing stays proportional.
      if (!node.hidden && (node.style.width || node.style.height) && !node.classList.contains('maximized')) {
        const snapped = arrangement.snapSize(node);
        const height = node.classList.contains('collapsed') ? parseFloat(node.style.getPropertyValue('--session-height')) || 405
          : snapped.height;
        layout.sizes[layoutId] = { width: snapped.width, height,
          viewportWidth: Math.floor(windows.clientWidth / 24) * 24, viewportHeight: innerHeight };
        node.style.width = '';
        node.style.height = '';
        arrangement.refresh();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveLayout, 150);
      }
    });
    observer.observe(node);
    const question = sessionQuestion(stateIcon, pluginId, session.id);
    const card = { node, terminal, display, model, connection, observer, heading, activity, stateIcon, prompt, question, branch, branchName, error, clear, newline, fork, retry, reconnect, interrupt, resetContext,
      collapseButton, maximizeButton, close, session };
    setCollapsed(card, layout.collapsed.includes(layoutId));
    void saveLayout();
    return card;
  }

  function update(data) {
    if (disposed || data.pluginId && data.pluginId !== pluginId) {
      return;
    }
    snapshot = { ...data, groups: data.groups || snapshot.groups };
    if (layout.activeGroup && !snapshot.groups.some(group => group.id === layout.activeGroup && (!group.archivedAt
      || snapshot.sessions.some(session => session.groupId === group.id)))) { layout.activeGroup = ''; }
    navigation.update(snapshot.groups, data.sessions, layout.activeGroup);
    const sessions = data.sessions.filter(session => (!session.windowId || session.windowId === windowId)
      && (!selectedSessions || selectedSessions.has(session.id)));
    for (const [id, card] of cards) {
      if (!sessions.some((s) => s.id === id)) {
        card.display.dispose();
        card.question.dispose();
        card.terminal.dispose();
        card.observer.disconnect();
        arrangement.remove(card.node);
        card.node.remove();
        cards.delete(id);
      }
    }
    for (const session of sessions) {
      // Defer terminal replay during recovery so it does not compete with engine startup.
      if (!cards.has(session.id) && root.getAttribute('aria-busy') === 'true') { continue; }
      if (!cards.has(session.id)) { cards.set(session.id, makeCard(session)); }
      const card = cards.get(session.id);
      card.session = session;
      const group = snapshot.groups.find(group => group.id === session.groupId);
      const roleName = session.agentRole?.name || (session.coordinator ? '组管理员' : '');
      const memberName = roleName ? `${session.name}（${roleName}）` : session.name;
      card.heading.textContent = group ? `${group.name} · ${memberName}` : memberName;
      card.heading.title = card.heading.textContent;
      card.node.hidden = (session.groupId || '') !== layout.activeGroup;
      card.display.update(session);
      card.terminal.setInputMode({ placeholder: session.coordinator ? '输入团队任务…' : '' });
      card.close.disabled = Boolean(session.coordinator);
      card.close.title = session.coordinator ? '固定组管理员不可单独关闭，可折叠或删除整个会话组' : '关闭';
      card.retry.hidden = !session.exited;
      const offline = session.error?.code === 'SESSION_OFFLINE' || !session.exited && disconnected;
      setButtonIcon(card.retry, offline ? '重新连接会话' : '重试', offline ? 'restore' : 'history');
      card.connection.update(session, disconnected);
      card.reconnect.hidden = !['codex', 'claude'].includes(session.adapterId) || session.exited;
      card.reconnect.disabled = Boolean(session.blocked) || !['idle', 'done', 'error'].includes(session.activity);
      card.interrupt.disabled = !!session.exited;
      card.resetContext.disabled = card.resetContext.hasAttribute('aria-busy') || Boolean(session.blocked)
        || !['idle', 'done', 'error'].includes(session.activity) || session.protocol !== 'managed-terminal'
        || !session.runtimeId || !['codex', 'claude'].includes(session.adapterId);
      card.activity.textContent = offline ? '连接不可用' : session.exited ? '已退出 · 可重试' : blockedText[session.blocked] || statusText[session.activity];
      // Running sessions use the status drawing; retain text only for stopped sessions awaiting archival.
      card.activity.hidden = !session.exited && !offline;
      // Local supervision can stay active between turns; the kettle reflects only native model activity.
      card.activity.dataset.state = offline ? 'offline' : session.blocked ? 'blocked' : session.activity;
      sessionStatus(card.stateIcon, card.activity.dataset.state, card.activity.textContent);
      card.prompt.textContent = `${blockedText[session.blocked] || '需要你的确认'} · 请在下方回复或选择`;
      card.branchName.textContent = session.git ? session.git.branch || session.git.commit?.slice(0, 7) || 'HEAD' : 'Git';
      card.branch.title = session.git ? `Git · ${card.branchName.textContent}` : 'Git';
      card.branch.setAttribute('aria-label', card.branch.title);
      card.error.hidden = !session.error || session.error.code === 'SESSION_OFFLINE';
      card.error.textContent = session.error ? session.error.message : '';
      const idle = !session.blocked && ['idle', 'done', 'error'].includes(session.activity) && !session.exited;
      // Draft editing remains available while Codex reports work, just like typing in its composer.
      card.clear.disabled = !!session.blocked || session.exited;
      card.newline.disabled = !!session.blocked || session.exited;
      card.fork.disabled = !idle;
      card.model.disabled = !idle || !['codex', 'claude'].includes(session.adapterId);
    }
    // Moving existing xterm nodes on every status update interrupts scrolling and pointer capture.
    const rank = card => {
      const index = layout.order.indexOf(card.node.dataset.layout);
      return index < 0 ? layout.order.length : index;
    };
    const ordered = [...cards.values()].sort((a, b) => rank(a) - rank(b));
    ordered.forEach(({ node }, index) => {
      if (windows.children[index] !== node) { windows.insertBefore(node, windows.children[index] || null); }
    });
    const maximized = layout.maximized.map(id => ordered.find(card => !card.node.hidden && card.node.dataset.layout === id)).filter(Boolean).at(-1);
    // Hidden groups keep their saved presentation without leaving an invisible overlay over the active group.
    cards.forEach(card => {
      if (card.node.classList.contains('maximized') !== (card === maximized)) {
        setMaximized(card, card === maximized, layout.collapsed.includes(card.node.dataset.layout));
      }
      card.prompt.hidden = card.question.update(card.session, { visible: !card.node.hidden })
        || !card.session.blocked || card.session.exited;
      card.node.classList.toggle('confirming', !card.prompt.hidden);
    });
    arrangement.refresh();
    empty.hidden = root.getAttribute('aria-busy') === 'true' || sessions.some(session => (session.groupId || '') === layout.activeGroup);
  }
  const off = api.events.sessionsChanged(update);
  const theme = (event) => cards.forEach((card) => card.terminal.setTheme(event.detail));
  window.addEventListener('desk-theme', theme);
  const connectivity = event => {
    disconnected = event.type === 'offline';
    update(snapshot);
  };
  window.addEventListener('online', connectivity);
  window.addEventListener('offline', connectivity);
  const dispose = () => {
    flushLayout();
    disposed = true;
    clearTimeout(saveTimer);
    window.removeEventListener('pagehide', flushLayout);
    window.removeEventListener('pointerup', flushLayout);
    off();
    arrangement.dispose();
    sidebar.dispose();
    window.removeEventListener('desk-theme', theme);
    window.removeEventListener('online', connectivity);
    window.removeEventListener('offline', connectivity);
    cards.forEach((card) => {
      card.display.dispose();
      card.question.dispose();
      card.observer.disconnect();
      card.terminal.dispose();
    });
  };
  const recoveryProgress = showRestoreProgress();
  try {
    update(await api.sessions.list(pluginId));
    // Track restored sessions during startup; terminal history replay starts after the engines are ready.
    const recovered = await recoverSessions(api.sessions, pluginId, windowId, await api.host.listWindows(), progress => {
      recoveryProgress.update(progress);
      // Restoring windows must not choose a group on the user's behalf.
      if (progress.total > 0 || progress.sessions.length > 0) {
        layout.activeGroup = null;
      }
      progress.sessions.filter(session => session.windowId === windowId).forEach(session => selectedSessions?.add(session.id));
      const additions = progress.sessions.filter(session => !snapshot.sessions.some(current => current.id === session.id));
      update({ ...snapshot, sessions: [...snapshot.sessions, ...additions] });
    });
    recovered.errors.forEach(error => toast(`“${error.name}”自动恢复失败：${error.message}；可在历史中重试。`));
    if (!selectedSessions) {
      const { sessions } = await api.sessions.list(pluginId);
      for (const session of sessions.filter(session => !session.windowId)) {
        await api.sessions.attachWindow(pluginId, session.id, windowId);
      }
    }
    const data = await api.sessions.list(pluginId);
    await recoveryProgress.finish();
    root.setAttribute('aria-busy', 'false');
    update(data);
    toolbar.inert = sidebar.node.inert = false;
    loading.remove();
    recoveryProgress.close();
    console.info('[session:workspace-ready]', { pluginId, windowId, sessions: cards.size, failed: recovered.errors.length });
    return dispose;
  } catch (error) {
    recoveryProgress.close();
    dispose();
    throw error;
  }
}
