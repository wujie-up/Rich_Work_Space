import { withUpgradeProgress } from './upgrade-progress.js';
import { openPluginSettings } from './plugin-settings.js';
import { pluginIcon } from './plugin-icon.js';
import { api, confirm, el, iconButton, icons, modal, switchButton, toast } from './ui.js';
import { bindLauncher, canOpen } from './launcher.js';
import { message } from './i18n.js';

export async function transition(id, action) {
  let preview;
  if (action === 'disable') {
    preview = await api.plugins.preview(id, action);
  }
  // Stopped tasks remain in the snapshot for archival, but do not need a disable warning.
  const choice = action === 'disable' && !preview.runningTasks.some(task => !task.exited) ? 'keep'
    : await modal({ close: '确认关闭', disable: '禁用插件', remove: '卸载插件' }[action], ({ body, actions, finish }) => {
    if (action === 'close') {
      body.append(el('p', { message: '仍有窗口未关闭，是否关闭？' }));
    }
    const tasks = el('div', {}, action === 'remove' ? el('p', { message: '正在获取任务列表…' }) : null);
    body.append(tasks);
    const policy = el('select', { 'aria-label-message': '插件数据策略' }, el('option', { value: 'keep', message: '保留插件数据（默认）' }),
      el('option', { value: 'clear', message: '清理此插件的配置、布局、日志和历史' }));
    if (action === 'remove') {
      body.append(policy, el('p', { class: 'muted', message: '清理仅作用于 DeskPG 内的此插件数据。插件目录外的文件保持原样。' }));
    }
    const proceed = iconButton(action === 'remove' ? icons.remove : icons.check,
      { close: '关闭', disable: '关闭并禁用', remove: '关闭并卸载' }[action], () => finish(action === 'close' && !preview ? 'force' : policy.value));
    proceed.disabled = action === 'remove';
    const cancel = iconButton(action === 'remove' ? icons.cancel : icons.close, '取消', () => finish(null));
    cancel.autofocus = action === 'close';
    actions.append(cancel, proceed);
    if (action === 'close') {
      // One confirmation also preserves the emergency path while preview RPC is unresponsive.
      message(proceed, '强制关闭，未保存内容可能丢失', 'title');
    }
    // The confirmation remains usable even when a broken plugin cannot produce its task snapshot.
    (preview ? Promise.resolve(preview) : api.plugins.preview(id, action)).then(value => {
      preview = value;
      tasks.replaceChildren();
      proceed.disabled = false;
      message(proceed, { close: '关闭', disable: '关闭并禁用', remove: '关闭并卸载' }[action], 'title');
      // Closing only needs a brief warning; retain the snapshot token for the existing archival flow.
      if (action === 'close') {
        return;
      }
      // Keep the full snapshot for archival and confirmation, but only warn about active work.
      const runningTasks = preview.runningTasks.filter(task => !task.exited);
      if (preview.closeDescription) {
        tasks.append(el('p', { class: 'muted', text: preview.closeDescription }));
      }
      if (runningTasks.length) {
        tasks.append(el('p', { message: ['将关闭 {count} 个任务。', { count: runningTasks.length }] }));
      } else if (action === 'remove') {
        tasks.append(el('p', { message: '当前没有待关闭任务。' }));
      }
      if (runningTasks.length) {
        const list = el('div', { class: 'confirm-task-list' });
        for (const session of runningTasks) {
          list.append(el('div', { class: 'confirm-session', title: session.name }, session.name,
            session.collapsed ? el('span', { message: ' · 已折叠' }) : null));
        }
        tasks.append(list);
      }
    }).catch(error => {
      tasks.replaceChildren(el('p', { class: 'error-box', message: ['无法获取任务列表：{error}', { error: error.message }] }));
    });
  }, { compact: action !== 'remove' });
  if (!choice) {
    return;
  }
  if (choice === 'force') {
    await api.plugins.forceClose(id);
    return;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await (action === 'remove' ? api.plugins.remove(id, choice, preview.confirmationToken)
          : api.plugins[action](id, preview.confirmationToken));
        break;
      } catch (error) {
        // Electron's context bridge preserves the message but drops custom Error properties.
        const busy = error.code === 'PLUGIN_BUSY' || error.message === '插件正在创建任务或执行操作';
        if (!busy || attempt === 4) {
          throw error;
        }
        // Retained views may briefly hold the lock while persisting their layout.
        console.info('[plugin:transition-wait]', { pluginId: id, action, attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (error) {
    if (error.code === 'CONFIRMATION_STALE' || error.message === '任务列表已变化，请重新预览并确认') {
      toast('任务列表已变化，请核对更新后的列表。');
      return transition(id, action);
    }
    throw error;
  }
}

async function upgrade(id, version) {
  // Refresh the task snapshot on each confirmation, retaining the selected package.
  for (;;) {
    const preview = await api.plugins.preview(id, 'upgrade');
    if (!await confirm('升级插件', '升级将关闭此插件的窗口和任务，保留配置、历史数据和启用状态。')) {
      return;
    }
    try {
      await withUpgradeProgress(id, version, () => api.plugins.upgradeLatest(id, version, preview.confirmationToken));
      return;
    } catch (error) {
      if (error.code !== 'CONFIRMATION_STALE' && error.message !== '任务列表已变化，请重新预览并确认') {
        throw error;
      }
      toast('任务列表已变化，请核对更新后的列表。');
    }
  }
}

export async function mountPlugins(root, openPlugin, layouts) {
  let disposed = false;
  let scan = { directory: '', updates: [], errors: [] };
  let upgrading = false;
  let order = [];
  try {
    const saved = JSON.parse(localStorage.getItem('plugin-order') || '[]');
    order = Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [];
  } catch (error) {
    order = [];
    console.error('[plugin:order-load]', { stack: error.stack });
  }
  const upgradeAll = iconButton('M8 14V3m-4 4 4-4 4 4m4 10V6m-4 4 4-4 4 4M4 18v3h16v-3', '一键升级全部插件', async () => {
    upgrading = true;
    upgradeAll.disabled = true;
    const updates = [...scan.updates];
    try {
      // Capture every task snapshot before the single confirmation; the host still validates each token at installation.
      const previews = await Promise.all(updates.map(update => api.plugins.preview(update.id, 'upgrade')));
      if (!await confirm('升级全部插件',
        ['将升级 {count} 个插件，关闭相关窗口和任务，保留配置、历史数据和启用状态。', { count: updates.length }],
        { placement: 'center' })) {
        return;
      }
      await withUpgradeProgress('全部插件', null, async () => {
        for (const [index, update] of updates.entries()) {
          await api.plugins.upgradeLatest(update.id, update.version, previews[index].confirmationToken);
        }
      });
    } catch (error) {
      console.error('[plugin:upgrade-all-failed]', { pluginIds: updates.map(update => update.id), stack: error.stack });
      throw error;
    } finally {
      upgrading = false;
      await refresh();
    }
  }, 'plugin-upgrade');
  upgradeAll.disabled = true;
  const check = iconButton(icons.retry, '检查插件更新', async () => {
    check.disabled = true;
    try {
      scan = await api.plugins.scanUpdates();
      await render();
    } catch (error) {
      console.error('[plugin:updates-manual]', { directory: scan.directory, error: error.stack });
      toast(error.message);
    } finally {
      check.disabled = !scan.directory;
    }
  });
  const render = async () => {
    const records = await api.plugins.list();
    if (disposed) {
      return;
    }
    check.disabled = !scan.directory;
    upgradeAll.disabled = upgrading || !scan.updates.length
      || records.some(record => record.operation && scan.updates.some(update => update.id === record.id));
    // Keep scan configuration out of the list without changing its manual-only update behavior.
    const settings = iconButton('m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
      '插件更新设置', () => modal('插件更新设置', ({ body }) => {
        const directory = el('input', { value: scan.directory, readOnly: true, 'aria-label-message': '插件包扫描目录',
          'placeholder-message': '未设置扫描目录' });
        const configure = async value => {
          scan = { directory: value, updates: [], errors: [] };
          directory.value = value;
          clear.disabled = !value;
          check.disabled = !value;
          await render();
          scan = await api.plugins.configureUpdates(value);
          await render();
        };
        const choose = iconButton('M3 7V5h6l2 2h10v13H3ZM3 10h18', '选择插件包扫描目录', async () => {
          const selected = await api.host.chooseDirectory({ defaultPath: scan.directory });
          if (selected) {
            await configure(selected);
          }
        });
        const clear = iconButton(icons.close, '清空扫描目录', () => configure(''));
        clear.disabled = !scan.directory;
        body.append(el('div', { class: 'plugin-update-directory' },
          el('label', {}, el('span', { message: '插件包扫描目录' }), directory), choose, clear));
      }, { compact: true }));
    root.replaceChildren(root.querySelector('.plugin-toolbar') || el('div', { class: 'plugin-toolbar' }, layouts,
      el('div', { class: 'row-actions' }, iconButton(icons.import, '导入本地插件', () => api.plugins.install()), check, upgradeAll, settings)));
    for (const error of scan.errors) {
      root.append(el('p', { class: 'error-box', message: error }));
    }
    const list = el('div', { class: 'plugin-grid', 'data-layout': localStorage.getItem('plugin-layout') === 'list' ? 'list' : 'grid' });
    const ranks = new Map(order.map((id, index) => [id, index]));
    const sorted = records.filter(record => record.state !== 'uninstalled')
      .sort((left, right) => (ranks.get(left.id) ?? order.length) - (ranks.get(right.id) ?? order.length));
    for (const record of sorted) {
      const row = el('article', { class: 'plugin-card', 'data-plugin': record.id });
      if (canOpen(record)) {
        bindLauncher(row, record, openPlugin);
      }
      row.append(el('div', { class: 'plugin-mark' }, pluginIcon(record)), el('h2', { text: record.name }));
      if (record.operation) {
        row.append(el('span', { class: 'badge', message: record.operation }));
      }
      row.append(el('p', { class: 'muted', text: `${record.id} · v${record.version}` }),
        record.description ? el('p', { text: record.description }) : el('p', { message: '本地可信插件' }));
      const properties = [
        { application: '应用插件', service: '服务插件', resource: '资源插件' }[record.type || 'application'],
        record.showIcon === false ? '隐藏图标' : '显示图标',
        record.loadOnStartup === false ? '按需加载' : '启动加载',
        { none: '无需后台', task: '任务完成退出', service: '持续后台' }[record.background || 'service']
      ];
      row.append(el('p', { class: 'muted', 'data-plugin-properties': record.id },
        ...properties.flatMap((message, index) => [index ? ' · ' : '', el('span', { message })])));
      if (record.lastError) {
        row.append(el('div', { class: 'error-box', message: ['{stage}：{error}（可重试）', { stage: record.lastError.stage, error: record.lastError.message }] }));
      }
      const actions = el('div', { class: 'row-actions' });
      const handle = iconButton('M9 4v2m6-2v2M9 11v2m6-2v2M9 18v2m6-2v2', '拖动排序', () => {}, 'plugin-sort-handle');
      row.draggable = true;
      handle.draggable = true;
      row.addEventListener('dragstart', event => {
        // Add sorting to card drags while retaining the launcher's desktop payload.
        event.dataTransfer.setData('application/x-deskpg-plugin-order', record.id);
        event.dataTransfer.effectAllowed = 'copyMove';
      });
      row.addEventListener('dragover', event => {
        if (event.dataTransfer.types.includes('application/x-deskpg-plugin-order')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      });
      row.addEventListener('drop', event => {
        const id = event.dataTransfer.getData('application/x-deskpg-plugin-order');
        const source = [...list.children].find(node => node.dataset.plugin === id);
        if (!source || source === row) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const bounds = row.getBoundingClientRect();
        list.insertBefore(source, event.clientY < bounds.top + bounds.height / 2 ? row : row.nextSibling);
        order = [...list.children].map(node => node.dataset.plugin);
        try {
          localStorage.setItem('plugin-order', JSON.stringify(order));
        } catch (error) {
          console.error('[plugin:order-save]', { pluginId: id, stack: error.stack });
          toast(error.message);
        }
      });
      actions.append(handle);
      actions.append(iconButton('m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', '插件配置', () => openPluginSettings(record.id)));
      const toggle = switchButton(record.state === 'enabled' ? '禁用' : '启用', record.state === 'enabled', async () => {
        toggle.disabled = true;
        try {
          // Disabling retains the existing task confirmation and archival flow.
          await (record.state === 'enabled' ? transition(record.id, 'disable') : api.plugins.enable(record.id));
        } catch (error) {
          console.error('[plugin:toggle]', { pluginId: record.id, state: record.state, stack: error.stack });
          throw error;
        } finally {
          toggle.disabled = Boolean(record.operation);
        }
      });
      toggle.disabled = Boolean(record.operation);
      actions.append(toggle);
      if (record.lastError || record.operation) {
        actions.append(iconButton(icons.power, '强制关闭', () => transition(record.id, 'close')));
      }
      const available = scan.updates.find(update => update.id === record.id);
      if (available) {
        const update = iconButton('M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
          ['升级到 v{version}', { version: available.version }], async () => {
            try {
              await upgrade(record.id, available.version);
            } finally {
              await refresh();
            }
          }, 'plugin-upgrade');
        update.disabled = Boolean(record.operation);
        actions.append(update);
      }
      if (record.state !== 'uninstalled') {
        actions.append(iconButton(icons.remove, '卸载', () => transition(record.id, 'remove')));
      }
      if (record.cleanupPending) {
        actions.append(iconButton(icons.retry, '重试数据清理', () => api.plugins.retryCleanup(record.id)));
      }
      row.append(actions);
      list.append(row);
    }
    root.append(list, el('p', { class: 'footnote', message: '支持 .plg 插件包（tar.gz 压缩归档）。仅导入你信任的代码。' }));
  };
  let pending;
  const refresh = (force = true) => {
    if (!pending) {
      pending = (async () => {
        const previous = JSON.stringify(scan);
        try {
          scan = await api.plugins.checkUpdates();
        } catch (error) {
          console.error('[plugin:updates-list]', error);
          scan = { ...scan, updates: [], errors: [error.message] };
        }
        if (force || previous !== JSON.stringify(scan)) {
          await render();
        }
      })().finally(() => { pending = null; });
    }
    return pending;
  };
  const off = api.events.pluginsChanged(() => refresh().catch((error) => toast(error.message)));
  await render();
  void refresh().catch(error => toast(error.message));
  return () => { disposed = true; off(); };
}
