import { Files } from './files.js';

export async function activate(context) {
  const clients = new Map();
  let operations = Promise.resolve();
  // Host exclusive methods reject contention; editor writes must queue instead of rejecting autosave or another window.
  const enqueue = work => {
    const result = operations.then(work);
    operations = result.catch(() => {});
    return result;
  };
  for (const method of ['workspace', 'list', 'read', 'save', 'openDocument']) {
    context.methods.register(`editor.${method}`, (client, ...args) => enqueue(() => {
      if (!clients.has(client)) { clients.set(client, new Files()); }
      return clients.get(client)[method](...args);
    }));
  }
  const key = `plugin-data/${context.pluginId}/drafts.json`;
  context.methods.register('editor.drafts', () => enqueue(() => context.storage.readJson(key, [])));
  context.methods.register('editor.draft', draft => enqueue(async () => {
    const drafts = await context.storage.readJson(key, []);
    const remaining = drafts.filter(entry => entry.id !== draft.id);
    if (!draft.remove) { remaining.push({ ...draft, updated: Date.now() }); }
    await context.storage.writeJson(key, remaining);
  }));
  context.views.register({ id: 'editor', title: '文本编辑器', entry: 'dist/renderer/index.html', contributes: { entries: ['text-document'] } });
  context.lifecycle.register({ snapshot: async () => [], stop: () => operations });
}
export async function deactivate() {}
