const { contextBridge } = require('electron');

const changed = new Set();
const closed = new Set();

// This contract stub supplies only launcher metadata; there is no plugin process or business state.
contextBridge.exposeInMainWorld('workDesk', {
  storage: { getPreferences: async () => JSON.parse(localStorage.getItem('test-preferences') || '{"theme":"system","gridSize":24}'),
    savePreferences: async value => localStorage.setItem('test-preferences', JSON.stringify(value)) },
  host: { info: async () => ({ version: 'test' }) },
  plugins: { list: async () => Array.from({ length: 6 }, (_, index) => ({ id: `desktop-probe-${index}`, name: `测试图标${index + 1}`, version: '1.2.3', author: index === 0 ? { name: '测试作者' } : undefined,
    settings: index === 0 && localStorage.getItem('test-settings') ? { entry: 'settings.html' } : undefined, state: localStorage.getItem(`test-plugin-state:${index}`) || 'enabled',
    singleInstance: Boolean(index === 0 && localStorage.getItem('test-single-instance')),
    running: Boolean(index === 0 && localStorage.getItem('test-overlays') && !localStorage.getItem('test-overlay-closed')),
    views: [{ id: 'probe', title: '测试图标', entry: 'index.html',
      ...(index === 0 && localStorage.getItem('test-overlays') ? { presentation:
        { type: 'overlay', width: 380, height: 360, collapsedWidth: 340, collapsedHeight: 36 } } : {}) }] })),
    start: async () => { localStorage.removeItem('test-overlay-closed'); changed.forEach(callback => callback()); },
    setIcon: async id => {
      localStorage.setItem('test-icon-changed', id);
      changed.forEach(callback => callback());
    },
    invoke: async (id, method) => ({ pluginId: id, method }),
    enable: async id => {
      localStorage.setItem(`test-plugin-state:${id.split('-').at(-1)}`, 'enabled');
      changed.forEach(callback => callback());
    },
    disable: async id => {
      if (localStorage.getItem('test-stale-confirmation')) {
        localStorage.removeItem('test-stale-confirmation');
        localStorage.setItem('test-running-tasks', JSON.stringify([{ name: '新执行的任务', exited: false }]));
        throw Error('任务列表已变化，请重新预览并确认');
      }
      localStorage.setItem(`test-plugin-state:${id.split('-').at(-1)}`, 'disabled');
      changed.forEach(callback => callback());
    },
    preview: async () => {
      if (localStorage.getItem('test-preview-hang')) {
        return new Promise(() => {});
      }
      return { runningTasks: JSON.parse(localStorage.getItem('test-running-tasks') || '[]'), confirmationToken: 'test', closeDescription: '停止测试任务，保留记录。' };
    },
    close: async id => { localStorage.setItem('test-overlay-closed', '1'); closed.forEach(callback => callback({ pluginId: id })); },
    forceClose: async id => {
      localStorage.setItem('test-force-closed', id);
      closed.forEach(callback => callback({ pluginId: id }));
    },
    forceDisable: async id => {
      localStorage.setItem(`test-plugin-state:${id.split('-').at(-1)}`, 'disabled');
      localStorage.setItem('test-force-closed', id);
      changed.forEach(callback => callback());
    }
  },
  events: { pluginClosed: callback => { closed.add(callback); return () => closed.delete(callback); }, capabilityApproval: () => () => {}, configure: () => () => {}, pluginsChanged: callback => {
    changed.add(callback);
    return () => changed.delete(callback);
  }, error: () => {}, pluginEvent: () => () => {} }
});
