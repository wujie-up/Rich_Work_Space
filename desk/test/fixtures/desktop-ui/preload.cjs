const { contextBridge } = require('electron');

let changed = () => {};

// This contract stub supplies only launcher metadata; there is no plugin process or business state.
contextBridge.exposeInMainWorld('workDesk', {
  storage: { getPreferences: async () => JSON.parse(localStorage.getItem('test-preferences') || '{"theme":"system","gridSize":24}'),
    savePreferences: async value => localStorage.setItem('test-preferences', JSON.stringify(value)) },
  host: { info: async () => ({ version: 'test' }) },
  plugins: { list: async () => Array.from({ length: 6 }, (_, index) => ({ id: `desktop-probe-${index}`, name: `测试图标${index + 1}`, state: localStorage.getItem(`test-plugin-state:${index}`) || 'enabled',
    views: [{ id: 'probe', title: '测试图标', entry: 'index.html' }] })),
    preview: async () => {
      if (localStorage.getItem('test-preview-hang')) {
        return new Promise(() => {});
      }
      return { runningTasks: [], confirmationToken: 'test' };
    },
    forceDisable: async id => {
      localStorage.setItem(`test-plugin-state:${id.split('-').at(-1)}`, 'disabled');
      localStorage.setItem('test-force-closed', id);
      changed();
    }
  },
  events: { configure: () => () => {}, pluginsChanged: callback => { changed = callback; return () => {}; }, error: () => {}, pluginEvent: () => () => {} }
});
