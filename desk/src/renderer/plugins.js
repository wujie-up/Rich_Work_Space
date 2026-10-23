import { api, el, button, modal, toast } from './ui.js';
import { bindLauncher, canOpen } from './launcher.js';

export async function transition(id, action) {
  // Closing a shell owns the same task shutdown and process boundary as disabling its plugin.
  const operation = action === 'close' ? 'disable' : action;
  let preview;
  const choice = await modal({ close: '关闭插件', disable: '禁用插件', remove: '卸载插件' }[action], ({ body, actions, finish }) => {
    if (action === 'close') {
      body.append(el('p', { text: '确认后将关闭此插件的全部窗口并结束插件进程，保留配置和历史。再次使用可在插件中心启用。' }));
    }
    const tasks = el('div', {}, el('p', { text: '正在获取任务列表…' }));
    body.append(tasks);
    const policy = el('select', { 'aria-label': '插件数据策略' }, el('option', { value: 'keep', text: '保留插件数据（默认）' }),
      el('option', { value: 'clear', text: '清理此插件的配置、布局、日志和历史' }));
    if (action === 'remove') {
      body.append(policy, el('p', { class: 'muted', text: '清理仅作用于 Work Desk 内的此插件数据。插件目录外的文件保持原样。' }));
    }
    const proceed = button({ close: '关闭插件', disable: '关闭并禁用', remove: '关闭并卸载' }[action],
      () => finish(policy.value), 'danger');
    proceed.disabled = true;
    actions.append(button('取消', () => finish(null)), proceed);
    if (operation === 'disable') {
      body.append(el('p', { class: 'muted', text: '插件无响应时可强制关闭。保留已保存的数据，未保存内容可能丢失。' }));
      actions.append(button('强制关闭', () => finish('force'), 'danger'));
    }
    // The confirmation remains usable even when a broken plugin cannot produce its task snapshot.
    api.plugins.preview(id, operation).then(value => {
      preview = value;
      tasks.replaceChildren(el('p', { text: preview.runningTasks.length
        ? `此操作将关闭并归档以下 ${preview.runningTasks.length} 个任务。` : '当前没有待关闭任务。' }));
      for (const session of preview.runningTasks) {
        tasks.append(el('div', { class: 'confirm-session', text: `${session.name}${session.collapsed ? ' · 已折叠' : ''}${session.exited ? ' · 已停止，待归档' : ''}` }));
      }
      proceed.disabled = false;
    }).catch(error => {
      tasks.replaceChildren(el('p', { class: 'error-box', text: `无法获取任务列表：${error.message}` }));
    });
  });
  if (!choice) {
    return;
  }
  if (choice === 'force') {
    await api.plugins.forceDisable(id);
    return;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await (operation === 'disable' ? api.plugins.disable(id, preview.confirmationToken) : api.plugins.remove(id, choice, preview.confirmationToken));
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
    if (error.code === 'CONFIRMATION_STALE') {
      toast('任务列表已变化，请核对更新后的列表。');
      return transition(id, action);
    }
    throw error;
  }
}

export async function mountPlugins(root, openPlugin) {
  let disposed = false;
  const render = async () => {
    const records = await api.plugins.list();
    if (disposed) {
      return;
    }
    root.replaceChildren(el('div', { class: 'page-heading' }, el('div', {}, el('div', { class: 'eyebrow', text: 'EXTENSIONS' }),
      el('h1', { text: '插件中心' }), el('p', { class: 'muted', text: '按需启用工作能力。任务和数据始终按插件归属管理。' })),
    button('＋ 导入本地插件', () => api.plugins.install(), 'primary')));
    const list = el('div', { class: 'plugin-grid', 'data-layout': localStorage.getItem('plugin-layout') === 'list' ? 'list' : 'grid' });
    for (const record of records.filter(record => record.state !== 'uninstalled')) {
      const row = el('article', { class: 'plugin-card', 'data-plugin': record.id });
      if (canOpen(record)) {
        bindLauncher(row, record, openPlugin);
      }
      const status = record.operation || ({ enabled: '已启用', disabled: '已禁用', uninstalled: '已卸载' }[record.state]);
      row.append(el('div', { class: 'plugin-mark', text: '⌘' }), el('h2', { text: record.name }),
        el('span', { class: `badge ${record.state}`, text: status }), el('p', { class: 'muted', text: `${record.id} · v${record.version}` }),
        el('p', { text: record.description || '本地可信插件' }));
      row.append(el('p', { class: 'muted', 'data-plugin-properties': record.id,
        text: `${{ application: '应用插件', service: '服务插件', resource: '资源插件' }[record.type || 'application']}
          · ${record.showIcon === false ? '隐藏图标' : '显示图标'}
          · ${record.loadOnStartup === false ? '按需加载' : '启动加载'}
          · ${{ none: '无需后台', task: '任务完成退出', service: '持续后台' }[record.background || 'service']}` }));
      if (canOpen(record)) {
        row.append(button('打开', () => openPlugin(record.id)));
      }
      if (record.lastError) {
        row.append(el('div', { class: 'error-box', text: `${record.lastError.stage}：${record.lastError.message}（可重试）` }));
      }
      const actions = el('div', { class: 'row-actions' });
      if (record.state === 'enabled') {
        actions.append(button('禁用', () => transition(record.id, 'disable')));
      } else if (record.state === 'disabled') {
        actions.append(button('启用', () => api.plugins.enable(record.id), 'primary'));
      }
      if (record.lastError || record.operation) {
        actions.append(button('强制关闭', () => transition(record.id, 'close'), 'danger'));
      }
      if (record.state !== 'uninstalled') {
        actions.append(button('卸载', () => transition(record.id, 'remove'), 'quiet-danger'));
      }
      if (record.cleanupPending) {
        actions.append(button('重试数据清理', () => api.plugins.retryCleanup(record.id), 'danger'));
      }
      row.append(actions);
      list.append(row);
    }
    root.append(list, el('p', { class: 'footnote', text: '支持 .plg 插件包（tar.gz 压缩归档）。仅导入你信任的代码。' }));
  };
  const off = api.events.pluginsChanged(() => render().catch((error) => toast(error.message)));
  await render();
  return () => { disposed = true; off(); };
}
