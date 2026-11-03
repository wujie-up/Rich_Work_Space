import { randomUUID } from 'node:crypto';
import { PingCodeClient } from './client.js';
import { currentMonth } from '../../shared/month-filter.js';

export class QueryJobs {
  constructor(store, { clientFactory = config => new PingCodeClient(config) } = {}) {
    this.store = store;
    this.clientFactory = clientFactory;
    this.jobs = new Map();
    this.stopped = false;
  }

  async start(input) {
    if (this.stopped) {
      throw Error('插件已停止，不能开始查询');
    }
    if (!['members', 'projects', 'tasks'].includes(input.kind)) {
      throw Error('查询类型无效');
    }
    if (input.kind === 'members' && !String(input.keywords || '').trim()) {
      throw Error('请输入人员名称');
    }
    const config = await this.store.snapshot();
    if (this.stopped) {
      throw Error('插件已停止，不能开始查询');
    }
    for (const [id, job] of this.jobs) {
      if (job.state === 'running') {
        this.cancel(id);
      } else {
        this.jobs.delete(id);
      }
    }
    const client = this.clientFactory(config);
    const id = randomUUID();
    const job = { id, kind: input.kind, state: 'running', revision: config.revision, progress: { loaded: 0, total: null },
      controller: new AbortController(), startedAt: Date.now() };
    this.jobs.set(id, job);
    job.work = (async () => {
      try {
        const signal = job.controller.signal;
        const result = input.kind === 'tasks' ? await client.tasks({ assigneeId: input.assigneeId,
          role: input.role,
          month: input.month ?? currentMonth(), dateField: input.dateField ?? 'completedAt',
          projectId: input.projectId ?? config.projectId, onProgress: value => { job.progress = value; } }, signal)
          : input.kind === 'members' ? await client.members(input.keywords.trim(), signal) : await client.projects(signal);
        if (!signal.aborted) {
          job.state = 'complete';
          job.result = result;
          job.completedAt = Date.now();
        }
      } catch (error) {
        if (!job.controller.signal.aborted) {
          job.state = 'failed';
          job.error = { code: error.code || 'QUERY_FAILED', message: error.code ? error.message : '查询失败，请重试' };
          console.error('[pingcode:query]', { pluginId: 'pingcode', queryId: id, code: job.error.code });
        }
      }
    })();
    console.info('[pingcode:query]', { pluginId: 'pingcode', queryId: id, kind: input.kind });
    return { id, revision: job.revision };
  }

  status(id) {
    const job = this.jobs.get(id);
    if (!job) {
      throw Error('查询已释放，请重新查询');
    }
    const { controller, work, ...visible } = job;
    return visible;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (job?.state === 'running') {
      job.state = 'cancelled';
      job.controller.abort();
      delete job.result;
    }
  }

  cancelAll() {
    for (const id of this.jobs.keys()) {
      this.cancel(id);
    }
  }

  async stop() {
    this.stopped = true;
    this.cancelAll();
    await Promise.all([...this.jobs.values()].map(job => job.work));
  }
}
