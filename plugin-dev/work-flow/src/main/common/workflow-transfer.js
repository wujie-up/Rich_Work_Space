import { randomUUID } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './errors.js';

const MAX_BYTES = 10 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Definitions travel independently of runtime data; imports never activate external listeners or reuse local accounts.
export class WorkflowTransfer {
  constructor({ workflows, types, activeRun, logger }) {
    Object.assign(this, { workflows, types, activeRun, logger });
  }

  async inspect(path) {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) {
        throw fail('INVALID_WORKFLOW_FILE', '请选择不超过 10 MB 的工作流 JSON 文件');
      }
      let document;
      try {
        document = JSON.parse(await file.readFile('utf8'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) { throw error; }
        throw fail('INVALID_WORKFLOW_FILE', '工作流文件不是有效的 JSON');
      }
      return this.preview(document);
    } finally {
      await file.close();
    }
  }

  preview(document) {
    if (!isObject(document) || document.format !== 'deckpg.workflow' || document.version !== 1) {
      throw fail('INVALID_WORKFLOW_FILE', '不支持的工作流格式或版本，需要 deckpg.workflow version=1');
    }
    const { workflow, warnings } = this.definition({ ...document.workflow, trigger: { mode: 'manual' } });
    return { document: { format: 'deckpg.workflow', version: 1, workflow }, warnings };
  }

  definition(input) {
    if (!isObject(input) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
      throw fail('INVALID_WORKFLOW_FILE', '工作流需要 nodes 和 edges 数组');
    }
    for (const node of input.nodes) {
      if (node?.params !== undefined && !isObject(node.params)) {
        throw fail('INVALID_WORKFLOW_FILE', `节点 ${node.id} 的参数必须是对象`);
      }
    }
    const normalized = this.workflows.validate(input);
    const warnings = [];
    const types = this.types();
    const nodes = normalized.nodes.map(node => {
      const type = types.find(type => type.type === node?.type);
      if (!type) { throw fail('INVALID_WORKFLOW_FILE', `未知节点能力：${node?.type || '未指定'}`); }
      const params = { ...node.params };
      for (const field of type.params || []) {
        if (!['credential', 'connection'].includes(field.kind)) { continue; }
        params[field.name] = '';
        warnings.push(`${node.title || type.label || node.id}：请重新选择${field.kind === 'credential' ? '邮件账号' : '消息连接'}`);
      }
      return { ...node, params };
    });
    const identities = new Set(nodes.map(node => node.id));
    if (input.edges.some(edge => !isObject(edge) || !identities.has(edge.from) || !identities.has(edge.to) || edge.from === edge.to)) {
      throw fail('INVALID_WORKFLOW_FILE', '连线引用了不存在的节点或节点自身');
    }
    const { name, edges, trigger, group } = normalized;
    return { workflow: { name, nodes, edges, trigger, ...(group ? { group } : {}) }, warnings };
  }

  async export({ workflow: input, directory }) {
    const { workflow } = this.definition(input);
    const name = workflow.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'workflow';
    const path = join(directory, `${name}-${randomUUID().slice(0, 8)}.workflow.json`);
    await writeFile(path, JSON.stringify({ format: 'deckpg.workflow', version: 1, workflow }, null, 2) + '\n', { flag: 'wx' });
    this.logger('info', 'workflow-exported', { workflowId: input.id, nodeCount: workflow.nodes.length, path });
    return { path, name: workflow.name, nodeCount: workflow.nodes.length };
  }

  async import({ document, targetId, confirmed }) {
    const { document: prepared, warnings } = this.preview(document);
    if (targetId) {
      if (confirmed !== true) { throw fail('IMPORT_CONFIRM_REQUIRED', '更新已有工作流需要二次确认'); }
      await this.workflows.read(targetId);
      if (this.activeRun(targetId)) { throw fail('RUN_BUSY', '该工作流正在运行，请暂停或结束后再导入更新'); }
    }
    const workflow = await this.workflows.save({ ...prepared.workflow, id: targetId || randomUUID(), trigger: { mode: 'manual' } });
    this.logger('info', 'workflow-imported', { workflowId: workflow.id, updated: Boolean(targetId), nodeCount: workflow.nodes.length });
    return { workflow, warnings };
  }
}
