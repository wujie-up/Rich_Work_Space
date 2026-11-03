import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { normalizeTrigger } from './triggers.js';
import { validateMessageWorkflow } from './message-input.js';
import { executionOrder } from './control-flow.js';
import { graphIssues } from './graph.js';

// Workflows are edited through the canvas; every write re-reads the file so a stale snapshot cannot win.
export class Workflows {
  constructor({ storage, pluginId, classify = () => ({}) }) {
    Object.assign(this, { storage, pluginId, classify });
  }

  #key() {
    return `plugin-data/${this.pluginId}/workflows.json`;
  }

  // Legacy labels get deterministic IDs before the first write, so parallel reads agree on identity.
  async #document() {
    const stored = await this.storage.readJson(this.#key(), { version: 1, items: [] });
    const items = Array.isArray(stored.items) ? stored.items : [];
    const groups = stored.version === 2 ? stored.groups : [...new Set(items.map(item => item.group).filter(Boolean))]
      .map(name => ({ id: `legacy-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`, name, collapsed: false }));
    return { version: 2, groups, groupOrder: stored.groupOrder, items: items.map(item => {
      const group = item.groupId ? groups.find(group => group.id === item.groupId) : groups.find(group => group.name === item.group);
      return this.#membership(item, group);
    }) };
  }

  async list() {
    return (await this.#document()).items;
  }

  async listGroups({ includeUngrouped = false } = {}) {
    const document = await this.#document();
    return includeUngrouped ? this.#directory(document) : document.groups;
  }

  // The default group participates in ordering without becoming a workflow membership ID.
  #directory(document) {
    const groups = [...document.groups, { id: '', name: '未分组', collapsed: false }];
    const order = document.groupOrder || [];
    return [...order.map(id => groups.find(group => group.id === id)).filter(Boolean),
      ...groups.filter(group => !order.includes(group.id))];
  }

  async reorderGroups({ id, targetId, position }) {
    if (!['before', 'after'].includes(position)) { throw fail('INVALID_ARGUMENT', '排序位置无效'); }
    const document = await this.#document();
    const directory = this.#directory(document);
    const source = this.#group(directory, id);
    this.#group(directory, targetId);
    if (id === targetId) { return directory.map(group => group.id); }
    const reordered = directory.filter(group => group.id !== id);
    reordered.splice(reordered.findIndex(group => group.id === targetId) + (position === 'after' ? 1 : 0), 0, source);
    const groupOrder = reordered.map(group => group.id);
    await this.storage.writeJson(this.#key(), { ...document, groupOrder, groups: reordered.filter(group => group.id) });
    return groupOrder;
  }

  #membership(workflow, group) {
    const { group: previousName, groupId: previousId, ...definition } = workflow;
    return { ...definition, ...(group ? { groupId: group.id, group: group.name } : {}) };
  }

  #group(groups, id) {
    const group = groups.find(group => group.id === id);
    if (!group) { throw fail('GROUP_NOT_FOUND', '分组已不存在，请重新选择'); }
    return group;
  }

  #groupName(groups, name, id) {
    if (typeof name !== 'string' || !name.trim()) { throw fail('INVALID_ARGUMENT', '请输入分组名称'); }
    const trimmed = name.trim();
    if (groups.some(group => group.name === trimmed && group.id !== id)) {
      throw fail('GROUP_EXISTS', '该分组名称已存在，请使用其他名称');
    }
    return trimmed;
  }

  async createGroup({ name }) {
    const document = await this.#document();
    const group = { id: randomUUID(), name: this.#groupName(document.groups, name), collapsed: false };
    await this.storage.writeJson(this.#key(), { ...document, groups: [...document.groups, group] });
    return group;
  }

  async setGroupCollapsed({ id, collapsed }) {
    if (typeof collapsed !== 'boolean') { throw fail('INVALID_ARGUMENT', '分组折叠状态必须为布尔值'); }
    const document = await this.#document();
    const group = this.#group(document.groups, id);
    if (group.collapsed === collapsed) { return group; }
    const updated = { ...group, collapsed };
    await this.storage.writeJson(this.#key(), { ...document,
      groups: document.groups.map(group => group.id === id ? updated : group) });
    return updated;
  }

  // Membership and directory are written together; run records live in separate files and are never touched here.
  async removeGroup({ id }) {
    const document = await this.#document();
    this.#group(document.groups, id);
    const moved = document.items.filter(item => item.groupId === id).map(item => this.#membership(item));
    await this.storage.writeJson(this.#key(), { ...document, groups: document.groups.filter(group => group.id !== id),
      items: document.items.map(item => item.groupId === id ? this.#membership(item) : item) });
    return moved;
  }

  async moveGroup({ workflowId, groupId }) {
    const document = await this.#document();
    const group = groupId ? this.#group(document.groups, groupId) : undefined;
    const workflow = document.items.find(item => item.id === workflowId);
    // Unsaved canvas drafts have no definition on disk; only their local membership is changed by the view.
    if (!workflow) { return null; }
    const moved = this.#membership(workflow, group);
    await this.storage.writeJson(this.#key(), { ...document,
      items: document.items.map(item => item.id === workflowId ? moved : item) });
    return moved;
  }

  // Refill this group's existing slots so unrelated groups and unsaved definition fields never move.
  async reorder({ workflowId, targetId, position }) {
    if (!['before', 'after'].includes(position)) { throw fail('INVALID_ARGUMENT', '排序位置无效'); }
    const document = await this.#document();
    const source = document.items.find(item => item.id === workflowId);
    const target = document.items.find(item => item.id === targetId);
    if (!source || !target) { throw fail('WORKFLOW_NOT_FOUND', '请先保存工作流后再排序'); }
    if (source.groupId !== target.groupId || (source.groupId && !document.groups.some(group => group.id === source.groupId))) {
      throw fail('GROUP_MISMATCH', '只能在同一分组内排序');
    }
    if (workflowId === targetId) { return document.items.map(item => item.id); }
    const members = document.items.filter(item => item.groupId === source.groupId && item.id !== workflowId);
    members.splice(members.findIndex(item => item.id === targetId) + (position === 'after' ? 1 : 0), 0, source);
    let index = 0;
    const items = document.items.map(item => item.groupId === source.groupId ? members[index++] : item);
    await this.storage.writeJson(this.#key(), { ...document, items });
    return items.map(item => item.id);
  }

  async read(workflowId) {
    const found = (await this.list()).find(item => item.id === workflowId);
    if (!found) {
      throw fail('WORKFLOW_NOT_FOUND', `未找到工作流：${workflowId}`);
    }
    return found;
  }

  // Transfer previews share canvas validation without persisting any changes.
  validate(input) {
    return this.#normalize(input, []);
  }

  async save(input) {
    const document = await this.#document();
    const normalized = this.#normalize(input, document.items);
    let group = input.groupId ? document.groups.find(group => group.id === input.groupId)
      : document.groups.find(group => group.name === normalized.group);
    // Portable imports carry names only. A missing local ID means a deleted group, never a new import.
    if (!input.groupId && normalized.group && !group) {
      group = { id: randomUUID(), name: normalized.group, collapsed: false };
      document.groups.push(group);
    }
    const current = this.#membership(normalized, group);
    const items = document.items.some(item => item.id === current.id)
      ? document.items.map(item => (item.id === current.id ? current : item))
      : [current, ...document.items];
    await this.storage.writeJson(this.#key(), { ...document, items });
    return current;
  }

  async remove(workflowId) {
    const document = await this.#document();
    await this.storage.writeJson(this.#key(), { ...document, items: document.items.filter(item => item.id !== workflowId) });
  }

  // The name argument remains supported for older callers; the view addresses groups by stable ID.
  async renameGroup({ id, group, name }) {
    const document = await this.#document();
    if (!id && (typeof group !== 'string' || !group.trim())) { throw fail('INVALID_ARGUMENT', '请输入分组名称'); }
    const source = id ? this.#group(document.groups, id) : document.groups.find(item => item.name === group.trim());
    const target = this.#groupName(document.groups, name, source?.id);
    if (!source) { return []; }
    if (source.name === target) { return document.items.filter(item => item.groupId === source.id); }
    const renamed = { ...source, name: target };
    const members = document.items.filter(item => item.groupId === source.id)
      .map(item => ({ ...this.#membership(item, renamed), updatedAt: Date.now() }));
    await this.storage.writeJson(this.#key(), { ...document,
      groups: document.groups.map(item => item.id === source.id ? renamed : item),
      items: document.items.map(item => members.find(member => member.id === item.id) || item) });
    return members;
  }

  #normalize(input, items) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw fail('INVALID_ARGUMENT', '工作流必须是对象');
    }
    const nodes = Array.isArray(input.nodes) ? input.nodes.map(node => this.#node(node, input.nodes)) : [];
    if (!nodes.length) {
      throw fail('INVALID_WORKFLOW', '工作流至少需要一个节点');
    }
    const edges = this.#edges(Array.isArray(input.edges) ? input.edges : [], nodes);
    const { issues } = graphIssues({ nodes, edges, classify: this.classify });
    if (issues.length) {
      throw fail('INVALID_WORKFLOW', `工作流结构不合法：${issues.join('；')}`);
    }
    if (nodes.some(node => ['flow.route', 'flow.loop', 'flow.parallel', 'flow.join'].includes(node.type))) {
      executionOrder({ nodes, edges });
    }
    validateMessageWorkflow({ nodes, trigger: input.trigger });
    if (input.group !== undefined && typeof input.group !== 'string') {
      throw fail('INVALID_WORKFLOW', '工作流分组必须是名称文本');
    }
    const id = input.id || randomUUID();
    return { id, name: String(input.name || '未命名工作流').trim() || '未命名工作流', nodes, edges,
      ...(input.group?.trim() ? { group: input.group.trim() } : {}),
      trigger: normalizeTrigger(input.trigger),
      updatedAt: Date.now(),
      createdAt: items.find(item => item.id === id)?.createdAt || input.createdAt || Date.now() };
  }

  #node(node, nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || !node.type) {
      throw fail('INVALID_WORKFLOW', '节点需要 id 和 type');
    }
    if (nodes.filter(item => item?.id === node.id).length !== 1) {
      throw fail('INVALID_WORKFLOW', `节点 ID 重复：${node.id}`);
    }
    return { id: node.id, type: node.type, title: String(node.title || node.type), x: Number(node.x) || 0, y: Number(node.y) || 0,
      ...Object.fromEntries(['width', 'height'].filter(key => Number.isFinite(node[key]) && node[key] > 0).map(key => [key, node[key]])),
      params: node.params && typeof node.params === 'object' && !Array.isArray(node.params) ? node.params : {} };
  }

  #edges(edges, nodes) {
    const identities = new Set(nodes.map(node => node.id));
    const seen = new Set();
    const result = [];
    for (const edge of edges) {
      if (!edge || !identities.has(edge.from) || !identities.has(edge.to) || edge.from === edge.to) {
        continue;
      }
      const key = `${edge.from}>${edge.to}`;
      // Duplicate connections describe the same dependency once.
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ from: edge.from, to: edge.to, ...(edge.branch ? { branch: String(edge.branch).trim() } : {}) });
    }
    return result;
  }
}
