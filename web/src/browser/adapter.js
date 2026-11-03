const channels = { messagesChanged: 'messages.changed', capabilityApproval: 'capabilities.approval', configure: 'host.configure',
  pluginsChanged: 'plugins.changed', pluginClosed: 'plugins.closed', pluginEvent: 'plugins.event', error: 'host.error' };

// Keep transport differences outside the shared desktop renderer.
export function browserApi(session, onRevoked) {
  const listeners = new Map();
  const initial = new Map();
  let opened = false;
  let revoked = false;
  let pluginRevision = 0;
  let subscribed;
  const subscription = new Promise(resolve => { subscribed = resolve; });
  const events = new EventSource('/api/events');
  const publish = (channel, value) => {
    if (channel === 'plugins.changed') {
      pluginRevision++;
      initial.delete('plugins.list');
    }
    listeners.get(channel)?.forEach(listener => listener(value));
  };
  events.onmessage = event => {
    const { channel, value } = JSON.parse(event.data);
    publish(channel, value);
  };
  const revoke = () => { revoked = true; initial.clear(); subscribed(); events.close(); onRevoked(); };
  events.addEventListener('revoked', revoke);
  events.onerror = async () => {
    try {
      const response = await fetch('/api/session');
      if (!response.ok) {
        revoke();
      } else {
        publish('host.error', { message: '网页连接中断，正在重新连接' });
      }
    } catch {
      revoke();
    }
  };
  events.onopen = () => {
    subscribed();
    if (opened) {
      publish('plugins.changed');
    }
    opened = true;
  };
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...options.headers, 'x-deckpg-csrf': session.csrf } });
    if (response.status === 401) {
      revoke();
    }
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      throw Object.assign(Error(result.error?.message || result.message || '网页操作失败'), result.error);
    }
    return result;
  }
  const rpc = async (method, ...args) => {
    // Read the plugin snapshot only after subscription so no startup change can fall between them.
    if (method === 'plugins.list') {
      await subscription;
    }
    if (revoked) {
      throw Error('网页登录已失效');
    }
    return (await request('/api/rpc', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) })).value;
  };
  // Start only the shared renderer's first three reads; settled results cannot leak unhandled rejections.
  for (const method of ['storage.getPreferences', 'plugins.list', 'desktop.list']) {
    initial.set(method, rpc(method).then(value => ({ value }), error => ({ error })));
  }
  const invoke = async (method, ...args) => {
    const revision = pluginRevision;
    const pending = !args.length && initial.get(method);
    initial.delete(method);
    if (method === 'storage.savePreferences') {
      initial.delete('storage.getPreferences');
    }
    if (revoked) {
      throw Error('网页登录已失效');
    }
    if (!pending) {
      return rpc(method, ...args);
    }
    const result = await pending;
    if (revoked) {
      throw Error('网页登录已失效');
    }
    if (method === 'plugins.list' && revision !== pluginRevision) {
      return rpc(method);
    }
    if (result.error) {
      throw result.error;
    }
    return result.value;
  };
  const group = (name, methods) => Object.fromEntries(methods.map(method => [method, (...args) => invoke(`${name}.${method}`, ...args)]));
  const unsupported = async () => { throw Error('此操作需要在 DeskPG 桌面端完成'); };
  const upload = async (file, purpose) => (await request(`/api/upload?name=${encodeURIComponent(file.name)}&purpose=${purpose}`,
    { method: 'POST', body: file })).value;
  function select({ extensions = [], multiple = false } = {}) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multiple;
      input.accept = extensions.filter(value => value !== '*').map(value => `.${value}`).join(',');
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve([]);
      input.click();
    });
  }
  const download = async name => {
    const link = document.createElement('a');
    link.href = `/api/download?name=${encodeURIComponent(name)}`;
    link.download = name;
    link.click();
  };
  return {
    plugins: { ...group('plugins', ['list', 'start', 'enable', 'preview', 'disable', 'forceDisable', 'close', 'forceClose', 'remove',
      'retryCleanup', 'invoke', 'resetIcon', 'setMultipleWindows', 'setAutoStart', 'checkUpdates', 'scanUpdates', 'upgradeLatest']),
      configureUpdates: unsupported,
      install: async () => invoke('plugins.install', await Promise.all((await select({ extensions: ['plg'], multiple: true }))
        .map(file => upload(file, 'package')))),
      upgrade: (id, token, confirmation) => invoke('plugins.upgrade', id, token, confirmation ?? null),
      setIcon: async id => {
        const [file] = await select({ extensions: ['svg', 'png', 'jpg', 'webp'] });
        if (file) {
          return invoke('plugins.setIcon', id, await upload(file, 'icon'));
        }
      } },
    desktop: { ...group('desktop', ['list', 'create', 'resolve', 'rename', 'trash', 'properties']),
      read: async name => {
        const file = await invoke('desktop.read', name);
        return { ...file, bytes: Uint8Array.from(Object.values(file.bytes)) };
      },
      pathForFile: file => file,
      import: files => Promise.all(files.map(file => upload(file, 'desktop'))), openExternal: download,
      copy: unsupported,
      paste: async files => {
        if (!files?.length) {
          throw Error('请将文件拖入网页，或使用浏览器粘贴文件');
        }
        return Promise.all([...files].map(file => upload(file, 'desktop')));
      } },
    storage: group('storage', ['getPreferences', 'savePreferences']),
    messages: group('messages', ['list', 'respond', 'defer']), capabilities: group('capabilities', ['approve']),
    host: { browser: true, username: session.username, chooseDirectory: unsupported, quit: unsupported,
      info: async () => ({ version: 'web', packaged: false }),
      pluginOrigin: plugin => `https://${location.hostname}:${plugin.webPort}`,
      chooseFile: async options => {
        const [file] = await select(options);
        if (!file) {
          return null;
        }
        const isPackage = options?.extensions?.includes('plg');
        const value = await upload(file, isPackage ? 'package' : 'desktop');
        return isPackage ? value : invoke('desktop.resolve', value.name);
      },
      openExternal: async value => {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol)) {
          return unsupported();
        }
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
      },
      logout: async () => { await request('/api/logout', { method: 'POST' }); revoke(); } },
    events: Object.fromEntries(Object.entries(channels).map(([name, channel]) => [name, listener => {
      const group = listeners.get(channel) || new Set();
      listeners.set(channel, group);
      group.add(listener);
      return () => group.delete(listener);
    }]))
  };
}
