import { basename, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const identity = file => resolve(file.root, file.path);
const reference = file => ({ root: file.root, path: file.path, name: basename(file.path) });
const validFile = file => file && typeof file.root === 'string' && isAbsolute(file.root)
  && typeof file.path === 'string' && file.path.length > 0;

// Manual order lives apart from access history, which changes on every successful save.
export class FileGroups {
  constructor(context) {
    this.context = context;
    this.key = `plugin-data/${context.pluginId}/file-groups.json`;
  }

  async read() {
    const saved = await this.context.storage.readJson(this.key, null);
    if (saved !== null) {
      if (!Array.isArray(saved.groups) || saved.groups[0]?.id !== 'ungrouped'
        || saved.groups.some(group => typeof group.id !== 'string' || typeof group.name !== 'string'
          || !Array.isArray(group.files) || group.files.some(file => !validFile(file)))) {
        throw Error('文件分组数据损坏，请先备份并恢复分组数据');
      }
      return saved;
    }
    const history = await this.context.storage.readJson(`plugin-data/${this.context.pluginId}/history.json`, []);
    const unique = new Map();
    history.filter(validFile).forEach(file => {
      if (!unique.has(identity(file))) {
        unique.set(identity(file), reference(file));
      }
    });
    const initial = { groups: [{ id: 'ungrouped', name: '未分组', files: [...unique.values()] }] };
    await this.context.storage.writeJson(this.key, initial);
    return initial;
  }

  group(state, id) {
    const group = state.groups.find(entry => entry.id === id);
    if (!group) {
      throw Error('文件分组已不存在，请重新选择');
    }
    return group;
  }

  name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) {
      throw Error('分组名称需要 1–60 个字符');
    }
    return value.trim();
  }

  async change(change) {
    const state = await this.read();
    const { action, groupId } = change;
    switch (action) {
      case 'create':
        state.groups.push({ id: randomUUID(), name: this.name(change.name), files: [] });
        break;
      case 'rename':
        this.group(state, groupId).name = this.name(change.name);
        break;
      case 'delete': {
        if (groupId === 'ungrouped') {
          throw Error('未分组不能删除');
        }
        state.groups[0].files.push(...this.group(state, groupId).files);
        state.groups = state.groups.filter(group => group.id !== groupId);
        break;
      }
      case 'add':
      case 'move':
      case 'remove':
        this.changeFile(state, change);
        break;
      default:
        throw Error('不支持的文件分组操作');
    }
    await this.context.storage.writeJson(this.key, state);
    console.info('[text-editor:groups]', { pluginId: this.context.pluginId, action, groupId, path: change.file?.path });
    return state;
  }

  changeFile(state, { action, file, groupId, before }) {
    if (!validFile(file) || (before && !validFile(before))) {
      throw Error('文件分组需要有效的文件引用');
    }
    const current = state.groups.flatMap(group => group.files).find(entry => identity(entry) === identity(file));
    if (action === 'add' && current) {
      return;
    }
    // A different window can delete the selected group while this document is being opened or saved.
    const destination = action === 'remove' ? null : action === 'add'
      ? state.groups.find(group => group.id === groupId) || state.groups[0] : this.group(state, groupId || 'ungrouped');
    if (before && !destination.files.some(entry => identity(entry) === identity(before))) {
      throw Error('排序目标已不存在，请刷新文件分组');
    }
    if (before && identity(before) === identity(file)) {
      return;
    }
    state.groups.forEach(group => {
      group.files = group.files.filter(entry => identity(entry) !== identity(file));
    });
    if (destination) {
      const index = before ? destination.files.findIndex(entry => identity(entry) === identity(before)) : destination.files.length;
      destination.files.splice(index, 0, reference(file));
    }
  }

  // A rename preserves group and position even when another workspace refers to the same file.
  async updateReferences(file, renamed) {
    const state = await this.read();
    const destination = renamed && resolve(file.root, renamed.path);
    const hasSource = state.groups.some(group => group.files.some(entry => identity(entry) === identity(file)));
    state.groups.forEach(group => {
      // A missing destination may still have an old library entry; source ownership wins on rename.
      if (destination && hasSource) {
        group.files = group.files.filter(entry => identity(entry) !== destination || identity(entry) === identity(file));
      }
      group.files = group.files.flatMap(entry => identity(entry) !== identity(file) ? [entry]
        : renamed ? [{ ...entry, path: relative(entry.root, resolve(file.root, renamed.path)), name: renamed.name }] : []);
    });
    await this.context.storage.writeJson(this.key, state);
  }
}
