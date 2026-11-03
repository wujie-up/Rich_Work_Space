// Keep TLS and SQLite off the desktop's disabled-by-default startup path.
export function nativeWeb(options) {
  let workspace;
  let pending;
  const get = async () => {
    pending ??= import('./workspace.js').then(({ WebWorkspace }) => {
      workspace = new WebWorkspace(options);
      return workspace;
    });
    return pending;
  };
  return {
    transport: {
      request: async (owner, action, input) => (await get()).transport.request(owner, action, input),
      closeOwner: owner => workspace?.transport.closeOwner(owner)
    },
    handlers: Object.fromEntries(['status', 'configure', 'listAccounts', 'saveAccount', 'removeAccount'].map(name =>
      [`web.${name}`, async (...args) => (await get())[name](...args)])),
    async restore() {
      const config = await options.storage.readJson('web/settings.json', { enabled: false });
      if (config.enabled) {
        await (await get()).start(config.port);
      }
    },
    emit: (channel, value) => workspace?.emit(channel, value),
    close: async () => { if (pending) { await (await pending).close(); } }
  };
}
