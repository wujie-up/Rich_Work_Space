import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MenuApi } from './menu-api.js';
import { generateSql, prepareDrafts, registryMappings, requireMenu, validId } from './menu-catalog.js';

const terminal = state => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
const REGISTRY = 'dbai-admin-server/src/main/java/com/dbai/admin/server/domain/permission/constants/MenuAppCodeRegistry.java';
const stages = ['load', 'tree', 'code', 'sql'];
export class MenuWorkflows {
  constructor({ storage, tasks, pluginId, api = settings => new MenuApi(settings) }) {
    Object.assign(this, { storage, tasks, pluginId, api });
    this.sessions = new Map();
    this.connections = new Map();
    this.starts = new Map();
  }
  key(runId) {
    requireMenu(/^[A-Za-z0-9-]+$/.test(runId), '无效运行 ID');
    return `plugin-data/${this.pluginId}/menu/${runId}.json`;
  }
  async session(runId) {
    if (!this.sessions.has(runId)) {
      const stored = await this.storage.readJson(this.key(runId), null);
      requireMenu(stored, '菜单会话不存在，请重新运行模板');
      // Restart never resumes a native task or a remote sync implicitly.
      for (const kind of ['planTask', 'codeTask']) {
        if (stored[kind] && !terminal(stored[kind].state)) {
          stored[kind].state = 'interrupted';
          stored[kind].error = '插件已重启，请重新发起任务';
        }
      }
      this.sessions.set(runId, stored);
    }
    return this.sessions.get(runId);
  }
  async save(session) {
    await this.storage.writeJson(this.key(session.runId), session);
    return this.read(session.runId);
  }
  async prepare(runId, stage) {
    if (!this.sessions.has(runId)) {
      this.sessions.set(runId, { runId, revision: 0, tenant: '0', catalog: [], appCodes: [], drafts: [], confirmations: {} });
    }
    const session = await this.session(runId);
    session.stage = stage;
    await this.save(session);
    return { stage, revision: session.revision };
  }
  async read(runId) {
    const session = await this.session(runId);
    const visible = structuredClone(session);
    delete visible.appCodes;
    for (const kind of ['planTask', 'codeTask']) {
      if (visible[kind]) { delete visible[kind].taskKey; }
    }
    return { ...visible, connected: this.connections.has(runId), registryFile: REGISTRY };
  }
  check(session, revision) { requireMenu(session.revision === revision, '修订已变化，请刷新后重新确认'); }
  connection(runId) {
    requireMenu(this.connections.has(runId), '请重新输入 token 连接菜单接口');
    return this.connections.get(runId);
  }
  async invalidate(session) {
    const tasks = ['planTask', 'codeTask'].map(key => session[key]).filter(Boolean);
    session.revision += 1;
    session.confirmations = session.confirmations.load ? { load: true } : {};
    delete session.sql;
    delete session.planTask;
    delete session.codeTask;
    delete session.questions;
    // A stale completion cannot become visible once its revision has been removed.
    await Promise.all(tasks.filter(task => !terminal(task.state)).map(task => this.cancelTask(task)));
  }
  async load(input) {
    const session = await this.session(input.runId);
    this.check(session, input.revision);
    const connection = this.api(input.connection);
    const tenant = validId(input.tenant ?? session.tenant);
    const [catalog, appCodes] = await Promise.all([connection.snapshot(), connection.appCodes(tenant)]);
    this.check(session, input.revision);
    await this.invalidate(session);
    Object.assign(session, { catalog, appCodes, tenant, confirmations: {}, loaded: true });
    this.connections.set(input.runId, connection);
    this.validate(session);
    console.info('[work-flow:menu-loaded]', { runId: input.runId, revision: session.revision, count: catalog.length });
    return this.save(session);
  }
  validate(session) {
    try {
      // The validated projection is disposable. Only the editable draft is persisted, without recursive parents.
      const prepared = prepareDrafts(session.catalog, session.drafts, session.appCodes);
      session.drafts = prepared.map(({ parentNode, system, level, ...draft }) => draft);
      session.validation = '';
      return prepared;
    } catch (error) {
      session.validation = error.message;
      return null;
    }
  }
  async edit(input) {
    const session = await this.session(input.runId);
    this.check(session, input.revision);
    requireMenu(session.loaded, '请先加载资源目录');
    requireMenu(Array.isArray(input.drafts) && input.drafts.length <= 200, '每批最多新增 200 项');
    const old = new Map(session.drafts.map(draft => [draft.key, draft]));
    const drafts = input.drafts.map(draft => ({ key: draft.key || `d:${randomUUID()}`, kind: draft.kind,
      name: draft.name, code: draft.code, parent: draft.parent || '', path: draft.path || '', sort: Number(draft.sort || 0),
      ...(draft.kind === 'MENU' ? { appCode: old.get(draft.key)?.appCode || randomUUID().replaceAll('-', '') } : {}) }));
    await this.invalidate(session);
    session.drafts = drafts;
    this.validate(session);
    return this.save(session);
  }
  async begin(session, kind, input, prompt, files) {
    const key = `${kind}Task`;
    requireMenu(!session[key] || terminal(session[key].state), '该 Agent 任务仍在运行，请先停止');
    const task = { taskKey: randomBytes(32).toString('hex'), providerId: input.providerId || '', revision: session.revision,
      state: 'starting' };
    session[key] = task;
    const controller = new AbortController();
    this.starts.set(task.taskKey, controller);
    await this.save(session);
    try {
      const result = await this.tasks.call(`agent.menu.${kind}.start.v1`, { taskKey: task.taskKey, cwd: input.cwd, prompt,
        ...(files ? { files } : {}) }, { providerId: task.providerId, signal: controller.signal });
      if (session[key] !== task || controller.signal.aborted) {
        await this.cancelTask(task);
      } else { Object.assign(task, result); }
    } catch (error) {
      if (!controller.signal.aborted && session[key] === task) { Object.assign(task, { state: 'failed', error: error.message }); }
      await this.save(session);
      if (!controller.signal.aborted) { throw error; }
    } finally {
      this.starts.delete(task.taskKey);
    }
    return this.save(session);
  }
  async plan(input) {
    const session = await this.session(input.runId);
    this.check(session, input.revision);
    requireMenu(session.loaded && typeof input.text === 'string' && input.text.trim(), '请加载目录并输入需求');
    const catalog = input.parent ? session.catalog.filter(node => node.key === input.parent || this.descendant(session.catalog, node, input.parent))
      : session.catalog;
    requireMenu(catalog.length, '请选择有效的目录分支');
    const prompt = `你是菜单初始化计划助手。只读，不得修改任何文件、执行 SQL 或调用同步。根据实际目录和需求返回一个 JSON 对象，不要 Markdown。\n`
      + `格式 {"additions":[{"key":"d:唯一英文标识","kind":"DIR|MENU|BUTTON|SYSTEM","name":"名称","code":"英文唯一code","parent":"实际节点key或同批先定义的d:key","path":"路由","sort":0}],"questions":[]}。\n`
      + `仅返回新增项，不重复已有草稿。缺少编码、路由或父节点有歧义时提问，不能猜父节点；菜单无需 appCode，由本地生成。不要输出 token。\n`
      + `实际目录：${JSON.stringify(catalog)}\n已有草稿：${JSON.stringify(session.drafts)}\n需求：${input.text}`;
    return this.begin(session, 'plan', input, prompt);
  }
  descendant(catalog, node, parent) {
    const seen = new Set();
    while (node?.parent && !seen.has(node.key)) {
      if (node.parent === parent) { return true; }
      seen.add(node.key);
      node = catalog.find(item => item.key === node.parent);
    }
    return false;
  }
  async code(input) {
    const session = await this.session(input.runId);
    this.check(session, input.revision);
    requireMenu(session.confirmations.tree === session.revision, '请先确认资源树');
    requireMenu(Array.isArray(input.scope) && input.scope.length && input.scope.every(item => item.file && item.reason?.trim()),
      '请逐项确认允许修改的文件与原因');
    const prompt = `实现已经人工确认的菜单代码映射。仅可修改以下已确认文件，不得提交、清理无关文件、执行 SQL 或同步机构。\n`
      + `范围及原因：${JSON.stringify(input.scope)}\n菜单映射：${JSON.stringify(registryMappings(this.validate(session)))}\n`
      + `确认资源：${JSON.stringify(session.drafts)}\n遵循项目 AGENTS.md 和现有代码风格，优先扩展 MenuAppCodeRegistry。`
      + `SQL 和 Java 必须使用给定同一个 appCode。需要范围外文件时停止并说明，不能自行修改。完成后说明实际改动、执行的验证及未验证项。`;
    return this.begin(session, 'code', input, prompt, input.scope.map(item => item.file));
  }
  async poll(input) {
    const session = await this.session(input.runId);
    const key = input.kind === 'code' ? 'codeTask' : 'planTask';
    const task = session[key];
    requireMenu(task, '请先启动 Agent 任务');
    if (terminal(task.state)) { return this.read(input.runId); }
    const result = await this.tasks.call('agent.task.read.v1', { taskKey: task.taskKey }, { providerId: task.providerId });
    if (session[key] !== task || task.revision !== session.revision) { return this.read(input.runId); }
    Object.assign(task, result);
    if (key === 'planTask' && result.state === 'succeeded') {
      try {
        const text = result.output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const plan = JSON.parse(text);
        requireMenu(Array.isArray(plan.additions) && plan.additions.length <= 200 && Array.isArray(plan.questions), 'Agent 计划格式无效');
        // Reuse edit's local appCode allocation and revision invalidation for every accepted AI result.
        await this.edit({ runId: input.runId, revision: session.revision, drafts: [...session.drafts, ...plan.additions] });
        session.questions = plan.questions.map(String);
      } catch (error) {
        task.state = 'failed';
        task.error = `计划无法应用：${error.message}`;
        session.planTask = task;
      }
    }
    return this.save(session);
  }
  async respond(input) {
    const session = await this.session(input.runId);
    this.check(session, input.revision);
    const task = session[input.kind === 'code' ? 'codeTask' : 'planTask'];
    requireMenu(task && !terminal(task.state), '任务已结束');
    return this.tasks.call('agent.task.respond.v1', { taskKey: task.taskKey, requestId: input.requestId,
      ...(input.answers ? { answers: input.answers } : { decision: input.decision }) }, { providerId: task.providerId });
  }
  async stopTask(input) {
    const session = await this.session(input.runId);
    const task = session[input.kind === 'code' ? 'codeTask' : 'planTask'];
    if (task && !terminal(task.state)) {
      await this.cancelTask(task);
      await this.save(session);
    }
    return this.read(input.runId);
  }
  async cancelTask(task) {
    // Cancel the host approval/invocation as well as any native task already registered.
    this.starts.get(task.taskKey)?.abort();
    task.state = 'cancelled';
    await this.tasks.call('agent.task.cancel.v1', { taskKey: task.taskKey }, { providerId: task.providerId });
  }
  async confirm(runId, stage, input) {
    const session = await this.session(runId);
    this.check(session, input.revision);
    requireMenu(stages.includes(stage), '未知确认步骤');
    if (stage === 'load') { requireMenu(session.loaded, '请先加载资源目录'); }
    if (stage === 'tree') {
      requireMenu(session.confirmations.load, '请先确认目录连接');
      requireMenu(!session.questions?.length, '请先处理 Agent 待澄清问题，修改草稿后再确认');
      requireMenu(this.validate(session) && session.drafts.length, session.validation || '请先添加资源');
    }
    if (stage === 'code') {
      requireMenu(session.confirmations.tree === session.revision, '请先确认资源树');
      if (input.skip) {
        requireMenu(!session.codeTask || terminal(session.codeTask.state), '请先停止代码 Agent');
      } else {
        const task = session.codeTask;
        requireMenu(task?.state === 'succeeded', '请等待代码任务成功并审查改动');
        const fresh = await this.tasks.call('agent.task.read.v1', { taskKey: task.taskKey }, { providerId: task.providerId });
        requireMenu(fresh.state === 'succeeded' && fresh.digest === input.digest && fresh.digest === task.digest,
          '代码摘要已变化，请重新审查');
      }
      session.codeSkipped = Boolean(input.skip);
    }
    if (stage === 'sql') {
      if (!session.codeSkipped && session.codeTask) {
        const fresh = await this.tasks.call('agent.task.read.v1', { taskKey: session.codeTask.taskKey },
          { providerId: session.codeTask.providerId });
        requireMenu(fresh.state === 'succeeded' && fresh.digest === session.codeTask.digest, '代码已变化，请返回资源树后重新审查');
      }
      requireMenu(session.confirmations.code === session.revision, '请先确认代码步骤');
      const connection = this.connection(runId);
      const [catalog, appCodes] = await Promise.all([connection.snapshot(), connection.appCodes(session.tenant)]);
      this.check(session, input.revision);
      const parents = new Set(session.drafts.map(draft => draft.parent).filter(key => !key.startsWith('d:')));
      requireMenu([...parents].every(key => {
        const old = session.catalog.find(node => node.key === key);
        const current = catalog.find(node => node.key === key);
        return old && current && ['id', 'kind', 'system', 'level', 'parent', 'code', 'name'].every(field => old[field] === current[field]);
      }), '来源父目录已变化，请返回目录步骤重新加载');
      const nodes = prepareDrafts(catalog, session.drafts, appCodes);
      session.sql = generateSql(session.tenant, nodes);
    }
    session.confirmations[stage] = stage === 'load' ? true : session.revision;
    console.info('[work-flow:menu-confirmed]', { runId, stage, revision: session.revision });
    await this.save(session);
    return { stage, revision: session.revision, count: session.drafts.length };
  }
  async preview(runId) {
    const session = await this.session(runId);
    requireMenu(session.confirmations.code === session.revision, '请先确认代码步骤');
    return { sql: generateSql(session.tenant, prepareDrafts(session.catalog, session.drafts, session.appCodes)) };
  }
  async sql(runId) {
    const session = await this.session(runId);
    requireMenu(session.sql && session.confirmations.sql === session.revision, '请完成所有步骤确认后获取 SQL');
    return { sql: session.sql, fileName: `menu-${runId}-r${session.revision}.sql` };
  }
  async exportSql(runId, directory) {
    const artifact = await this.sql(runId);
    requireMenu(typeof directory === 'string' && isAbsolute(directory), '请选择 SQL 保存目录');
    const path = join(directory, artifact.fileName);
    try {
      // Never overwrite an existing SQL file through a directory-only chooser.
      await writeFile(path, artifact.sql, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') { throw Error('该 SQL 文件已存在，请选择其他目录或手动移走旧文件'); }
      throw error;
    }
    console.info('[work-flow:menu-exported]', { runId, fileName: artifact.fileName });
    return { path };
  }
  async roots(input) {
    if (input.connection) { this.connections.set(input.runId, this.api(input.connection)); }
    return (await this.connection(input.runId).snapshot()).filter(node => ['MENU', 'DIR'].includes(node.kind) && node.parent_id === '0');
  }
  async sync(input) {
    await this.sql(input.runId);
    requireMenu(input.sqlExecuted === true, '请先手动执行 SQL，再明确确认同步');
    const result = await this.connection(input.runId).sync(input.menuId, input.institutions);
    console.info('[work-flow:menu-synced]', { runId: input.runId, menuId: input.menuId });
    return result;
  }
  async cancel(runId) {
    if (!this.sessions.has(runId)) { return; }
    await this.stopTask({ runId, kind: 'plan' });
    await this.stopTask({ runId, kind: 'code' });
    this.connections.delete(runId);
  }
  async stop() {
    for (const runId of this.sessions.keys()) { await this.cancel(runId); }
  }
}
export function menuTypes(menus) {
  return stages.map((stage, index) => ({ type: `menu.${stage}`, label: ['加载目录', '规划并确认资源树', '代码修改与确认', '生成 SQL'][index],
    summary: '菜单初始化：逐步人工确认，SQL 输出后手动同步机构。', manual: true, io: 'transform', kind: 'invoke', role: 'step',
    timeoutMs: 30000, params: [], prepare: context => menus.prepare(context.runId, stage),
    confirm: (input, context) => menus.confirm(context.runId, stage, input), cancel: context => menus.cancel(context.runId) }));
}
