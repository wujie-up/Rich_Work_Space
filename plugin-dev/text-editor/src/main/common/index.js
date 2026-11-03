import { Files } from './files.js';
import { basename, relative, resolve } from 'node:path';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { registerTextTransfers } from './text-transfer.js';
import { FileGroups } from './file-groups.js';

export async function activate(context) {
  const clients = new Map();
  const textTransfers = new Map();
  let operations = Promise.resolve();
  // Host exclusive methods reject contention; editor writes must queue instead of rejecting autosave or another window.
  const enqueue = work => {
    const result = operations.then(work);
    operations = result.catch(() => {});
    return result;
  };
  const historyKey = `plugin-data/${context.pluginId}/history.json`;
  const groups = new FileGroups(context);
  // Describe responses only, so disk status never changes persisted grouping or history.
  async function describeGroups(state) {
    return { ...state, groups: await Promise.all(state.groups.map(async group => ({
      ...group, files: await Promise.all(group.files.map(file => Files.describe(file)))
    }))) };
  }
  context.methods.register('editor.groups', () => enqueue(async () => describeGroups(await groups.read())));
  context.methods.register('editor.organize', change => enqueue(async () => {
    try {
      return await describeGroups(await groups.change(change));
    } catch (error) {
      console.error('[text-editor:groups] change failed', { pluginId: context.pluginId, action: change.action, groupId: change.groupId }, error);
      throw error;
    }
  }));
  // Organization is supplementary: a storage failure must not invalidate a successful file read/save.
  async function organizeAccess(entry, groupId) {
    try {
      await groups.change({ action: 'add', file: entry, groupId });
      return '';
    } catch (error) {
      console.error('[text-editor:groups] access sync failed', { pluginId: context.pluginId, root: entry.root, path: entry.path }, error);
      return '文件分组更新失败，文件已正常打开或保存';
    }
  }
  async function organizeReferences(file, renamed) {
    try {
      await groups.updateReferences(file, renamed);
    } catch (error) {
      console.error('[text-editor:groups] reference sync failed', { pluginId: context.pluginId, root: file.root, path: file.path }, error);
      return '文件操作已完成，分组引用更新失败';
    }
    return '';
  }
  context.methods.register('editor.history', () => enqueue(async () => {
    const history = await context.storage.readJson(historyKey, []);
    return Promise.all(history.map(file => Files.describe(file)));
  }));
  for (const method of ['workspace', 'list', 'read', 'save', 'openDocument']) {
    const execute = async (files, ...args) => {
      let destination = files;
      if (method === 'save' && (args[0].desktop || args[0].root)) {
        // Bind a new destination without changing the open document's root when a save fails.
        destination = new Files();
        try {
          const root = args[0].desktop ? await context.storage.path('desktop-files') : args[0].root;
          if (args[0].desktop) {
            await mkdir(root, { recursive: true, mode: 0o700 });
          }
          destination.root = await realpath(root);
        } catch (error) {
          console.error('[text-editor:save-destination]', { pluginId: context.pluginId, path: args[0].path, root: args[0].root }, error);
          throw error;
        }
      }
      const result = await destination[method](...args);
      files.root = destination.root;
      if (method === 'save') {
        result.root = files.root;
      }
      if (['read', 'save', 'openDocument'].includes(method)) {
        // Record successful access only; distinct directories can contain the same file name.
        const history = await context.storage.readJson(historyKey, []);
        const entry = { root: files.root, path: result.path, name: basename(result.path), updated: Date.now() };
        const groupId = method === 'read' ? args[1]?.groupId : args[0]?.groupId;
        const warning = await organizeAccess(entry, groupId);
        if (warning) {
          result.organizationWarning = warning;
        }
        await context.storage.writeJson(historyKey, [entry, ...history.filter(file => file.root !== entry.root || file.path !== entry.path)]);
      }
      return result;
    };
    const handler = (client, ...args) => enqueue(() => {
      if (!clients.has(client)) { clients.set(client, new Files()); }
      return execute(clients.get(client), ...args);
    });
    context.methods.register(`editor.${method}`, handler);
    if (method === 'save') {
      textTransfers.set('editor.save', { handler, index: 1, fields: ['text'], prepare: ([client]) => enqueue(() => {
        // Uploading yields to other requests; bind this save before the client can switch directories.
        const files = Object.assign(new Files(), { root: clients.get(client)?.root });
        return (_client, ...args) => enqueue(() => execute(files, ...args));
      }) });
    }
  }
  const key = `plugin-data/${context.pluginId}/drafts.json`;
  const matches = (entry, file) => entry.root && entry.path && resolve(entry.root, entry.path) === resolve(file.root, file.path);
  // Keep all references consistent while retaining unfinished text after a physical deletion.
  async function updateReferences(file, renamed) {
    const history = await context.storage.readJson(historyKey, []);
    const destination = renamed && resolve(file.root, renamed.path);
    const moved = entry => ({ ...entry, path: relative(entry.root, destination), name: renamed.name });
    await context.storage.writeJson(historyKey, destination
      ? history.map(entry => matches(entry, file) ? moved(entry) : entry)
      : history.filter(entry => !matches(entry, file)));
    const drafts = await context.storage.readJson(key, []);
    await context.storage.writeJson(key, drafts.map(entry => !matches(entry, file) ? entry
      : destination ? moved(entry) : { ...entry, path: null, revision: null, saved: '' }));
    return organizeReferences(file, renamed);
  }
  context.methods.register('editor.removeHistory', file => enqueue(async () => {
    const history = await context.storage.readJson(historyKey, []);
    await context.storage.writeJson(historyKey, history.filter(entry => !matches(entry, file)));
    const organizationWarning = await organizeReferences(file);
    console.info('[text-editor] history removed', { pluginId: context.pluginId, path: file.path, root: file.root });
    return { organizationWarning };
  }));
  for (const method of ['renameFile', 'deleteFile']) {
    context.methods.register(`editor.${method}`, (file, name) => enqueue(async () => {
      try {
        const files = new Files();
        await files.workspace(file.root);
        const result = await files[method](file.path, name);
        const organizationWarning = await updateReferences(file, result);
        console.info(`[text-editor] ${method}`, { pluginId: context.pluginId, root: file.root, path: file.path, destination: result?.path });
        return result ? { ...result, organizationWarning } : { organizationWarning };
      } catch (error) {
        console.error(`[text-editor] ${method} failed`, { pluginId: context.pluginId, root: file.root, path: file.path, error: error.message });
        throw error;
      }
    }));
  }
  context.methods.register('editor.drafts', (options = {}) => enqueue(async () => {
    const drafts = await context.storage.readJson(key, []);
    // The always-visible list needs labels only; do not resend large document bodies on each edit.
    return options.metadata ? drafts.map(({ text, saved, ...draft }) => draft) : drafts;
  }));
  const saveDraft = draft => enqueue(async () => {
    const drafts = await context.storage.readJson(key, []);
    const remaining = drafts.filter(entry => entry.id !== draft.id);
    if (!draft.remove) { remaining.push({ ...draft, updated: Date.now() }); }
    await context.storage.writeJson(key, remaining);
  });
  context.methods.register('editor.draft', saveDraft);
  textTransfers.set('editor.draft', { handler: saveDraft, index: 0, fields: ['text', 'saved'] });
  const clearTransfers = registerTextTransfers(context, textTransfers);
  const manifest = JSON.parse(await readFile(new URL('../../../plugin.json', import.meta.url), 'utf8'));
  context.views.register(manifest.views[0]);
  context.lifecycle.register({ snapshot: async () => [], stop: () => {
    clearTransfers();
    return operations;
  } });
}
export async function deactivate() {}
