import { randomUUID } from 'node:crypto';
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

  async list() {
    const stored = await this.storage.readJson(this.#key(), { version: 1, items: [] });
    return Array.isArray(stored.items) ? stored.items : [];
  }

  async read(workflowId) {
    const found = (await this.list()).find(item => item.id === workflowId);
    if (!found) {
      throw fail('WORKFLOW_NOT_FOUND', `未找到工作流：${workflowId}`);
    }
    return found;
  }

  async save(input) {
    const items = await this.list();
    const current = this.#normalize(input, items);
    const next = items.some(item => item.id === current.id)
      ? items.map(item => (item.id === current.id ? current : item))
      : [current, ...items];
    await this.storage.writeJson(this.#key(), { version: 1, items: next });
    return current;
  }

  async remove(workflowId) {
    await this.storage.writeJson(this.#key(), { version: 1, items: (await this.list()).filter(item => item.id !== workflowId) });
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
    if (nodes.some(node => ['flow.route', 'flow.loop'].includes(node.type))) {
      executionOrder({ nodes, edges });
    }
    validateMessageWorkflow({ nodes, trigger: input.trigger });
    const id = input.id || randomUUID();
    return { id, name: String(input.name || '未命名工作流').trim() || '未命名工作流', nodes, edges,
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
