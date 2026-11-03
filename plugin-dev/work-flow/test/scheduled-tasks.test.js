import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Workflows } from '../src/main/common/workflows.js';
import { Scheduler } from '../src/main/common/triggers.js';
import { ScheduledTasks } from '../src/main/common/scheduled-tasks.js';

async function fixture(t, trigger, now = Date.now()) {
  let remove;
  const storage = await temporaryStore({ after: cleanup => { remove = cleanup; } });
  const schedulers = [];
  t.after(async () => {
    schedulers.forEach(scheduler => scheduler.stop());
    await Promise.all(schedulers.map(scheduler => scheduler.drain()));
    await tasks?.pending;
    await remove();
  });
  const workflows = new Workflows({ storage, pluginId: 'work-flow' });
  const target = await workflows.save({ name: '定时测试', trigger,
    nodes: [{ id: 'a', type: 'text.input', params: { content: 'x' } }], edges: [] });
  const engine = { records: new Map(), activeRun: () => false, started: [], start: async (workflow, { runId }) => {
    const run = { id: runId, workflowId: workflow.id, status: 'succeeded', startedAt: now, endedAt: now + 1 };
    engine.started.push(run);
    engine.records.set(run.id, run);
    await tasks.changed(run);
    return run;
  } };
  let tasks;
  const create = () => {
    tasks = new ScheduledTasks({ storage, pluginId: 'work-flow' });
    const scheduler = new Scheduler({ workflows, engine, tasks, logger: () => {}, pluginId: 'work-flow', now: () => now, maxDelay: 20 });
    schedulers.push(scheduler);
    return scheduler;
  };
  return { target, storage, workflows, engine, create, tasks: () => tasks, time: value => { now = value; } };
}

const cycle = { mode: 'interval', every: 1, unit: 'minute', enabled: true };
async function waitForFire(scheduler) {
  const deadline = Date.now() + 3000;
  while (scheduler.inFlight.size || scheduler.planned().some(row => row.nextAt <= scheduler.now())) {
    assert.ok(Date.now() < deadline, '定时任务应完成并推进到未来排期');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('排期持久化，重启保留原时间；漏跑多个周期只补一次，并记录最终结果', async t => {
  const f = await fixture(t, cycle);
  const first = f.create();
  await first.refresh();
  const due = first.planned()[0].nextAt;
  first.stop();
  f.time(due - 1000);
  const before = f.create();
  await before.refresh();
  assert.equal(before.planned()[0].nextAt, due);
  before.stop();
  f.time(due + 180000);
  const after = f.create();
  await after.refresh();
  await waitForFire(after);
  assert.equal(f.engine.started.length, 1);
  const [row] = await f.tasks().list();
  assert.equal(row.workflowId, f.target.id);
  assert.equal(row.lastStatus, 'succeeded');
  assert.equal(row.lastRunId, f.engine.started[0].id);
  assert.equal(row.lastStartedAt, due + 180000);
  assert.equal(row.lastEndedAt, due + 180001);
  assert.equal(row.lastSource, 'schedule');
  assert.equal(row.nextAt, due + 240000);
});

test('过期单次任务补跑一次，重启不重复；立即触发不改变排期', async t => {
  const at = '2026-11-03 09:00';
  const f = await fixture(t, { mode: 'once', at, enabled: true }, new Date('2026-11-03T10:00').getTime());
  const scheduler = f.create();
  await scheduler.refresh();
  await waitForFire(scheduler);
  assert.equal(f.engine.started.length, 1);
  assert.equal((await f.tasks().list())[0].nextAt, null);
  scheduler.stop();
  const restarted = f.create();
  await restarted.refresh();
  await waitForFire(restarted);
  assert.equal(f.engine.started.length, 1);
  await restarted.triggerNow(f.target.id);
  assert.equal(f.engine.started.length, 2);
  assert.equal((await f.tasks().list())[0].lastSource, 'manual');
  assert.equal((await f.tasks().list())[0].nextAt, null);
});

test('每日任务恢复原到期时间并补跑；禁用后不补跑，重新启用产生新排期', async t => {
  const f = await fixture(t, { mode: 'daily', at: '10:00', enabled: true }, Date.parse('2026-11-03T01:00:00Z'));
  const before = f.create();
  await before.refresh();
  before.stop();
  f.time(Date.parse('2026-11-05T03:00:00Z'));
  const after = f.create();
  await after.refresh();
  await waitForFire(after);
  assert.equal(f.engine.started.length, 1);
  assert.equal(after.planned()[0].nextAt, Date.parse('2026-11-06T02:00:00Z'));
  await f.workflows.save({ ...f.target, trigger: { ...f.target.trigger, enabled: false } });
  await after.refresh();
  assert.deepEqual(after.planned(), []);
  assert.equal((await f.tasks().list())[0].nextAt, null);
  await f.workflows.save(f.target);
  await after.refresh();
  assert.equal(after.planned()[0].nextAt, Date.parse('2026-11-06T02:00:00Z'));
});

test('立即触发保留未来排期，执行中拒绝重复运行，启动失败保留失败详情', async t => {
  const f = await fixture(t, cycle);
  const scheduler = f.create();
  await scheduler.refresh();
  const due = scheduler.planned()[0].nextAt;
  await scheduler.triggerNow(f.target.id);
  assert.equal(scheduler.planned()[0].nextAt, due);
  f.engine.activeRun = () => true;
  await assert.rejects(scheduler.triggerNow(f.target.id), { code: 'RUN_BUSY' });
  f.engine.activeRun = () => false;
  f.engine.start = async () => { throw Error('启动失败'); };
  await assert.rejects(scheduler.triggerNow(f.target.id), /启动失败/);
  const [row] = await f.tasks().list();
  assert.equal(row.lastStatus, 'failed');
  assert.equal(row.lastError.message, '启动失败');
  assert.equal(row.nextAt, due);
});

test('执行表并发记录互不覆盖；只追踪关联运行，旧事件不覆盖新运行', async t => {
  const storage = await temporaryStore(t);
  const tasks = new ScheduledTasks({ storage, pluginId: 'work-flow' });
  const a = { id: 'a', trigger: cycle };
  const b = { id: 'b', trigger: cycle };
  await Promise.all([tasks.plan(a, 1000), tasks.plan(b, 1000)]);
  await Promise.all([tasks.claim(a, { runId: 'r-a', source: 'manual', startedAt: 2000 }),
    tasks.claim(b, { runId: 'r-b', source: 'manual', startedAt: 2000 })]);
  await Promise.all([tasks.changed({ id: 'r-a', workflowId: 'a', status: 'failed', startedAt: 2000,
    endedAt: 3000, error: { message: '请求失败' } }),
  tasks.changed({ id: 'r-b', workflowId: 'b', status: 'succeeded', startedAt: 2000, endedAt: 3000 })]);
  await tasks.changed({ id: 'old', workflowId: 'a', status: 'succeeded' });
  const rows = await new ScheduledTasks({ storage, pluginId: 'work-flow' }).list();
  assert.equal(rows.find(row => row.workflowId === 'a').lastStatus, 'failed');
  assert.equal(rows.find(row => row.workflowId === 'b').lastStatus, 'succeeded');
});

test('启动记录已落盘但排期未推进时，重启不重复提交；未启动的领取项仍补跑', async t => {
  for (const persisted of [true, false]) {
    const f = await fixture(t, cycle);
    const before = f.create();
    await before.refresh();
    const due = before.planned()[0].nextAt;
    await f.tasks().claim(f.target, { runId: 'claimed', source: 'schedule', startedAt: due, scheduledAt: due });
    if (persisted) {
      f.engine.records.set('claimed', { id: 'claimed', workflowId: f.target.id, startedAt: due,
        endedAt: due + 100, status: 'interrupted' });
    }
    before.stop();
    f.time(due + 1000);
    const after = f.create();
    await after.refresh();
    await waitForFire(after);
    assert.equal(f.engine.started.length, persisted ? 0 : 1);
    assert.ok(after.planned()[0].nextAt > due + 1000);
  }
});

test('新增执行表写入故障不影响原手动运行，故障日志含业务标识及堆栈', async t => {
  const f = await fixture(t, cycle);
  const scheduler = f.create();
  await scheduler.refresh();
  const errors = [];
  scheduler.logger = (level, event, fields) => errors.push({ level, event, fields });
  const start = f.engine.start;
  f.engine.start = async (...args) => {
    const changed = f.tasks().changed;
    f.tasks().changed = async () => {};
    try { return await start(...args); } finally { f.tasks().changed = changed; }
  };
  f.tasks().claim = async () => { throw Error('磁盘写入失败'); };
  const run = await scheduler.triggerNow(f.target.id);
  assert.equal(run.status, 'succeeded');
  assert.ok(errors.some(item => item.level === 'error' && item.fields.workflowId === f.target.id
    && item.fields.stack.includes('磁盘写入失败')));
});

test('秒级任务关闭超过一万周期仍只补一次，下一次必须位于未来', async t => {
  const f = await fixture(t, { ...cycle, unit: 'second' });
  const before = f.create();
  await before.refresh();
  const due = before.planned()[0].nextAt;
  before.stop();
  f.time(due + 20000000);
  const after = f.create();
  await after.refresh();
  await waitForFire(after);
  assert.equal(f.engine.started.length, 1);
  assert.equal(after.planned()[0].nextAt, due + 20001000);
});

test('已有任务改为已过期的单次时间仍立即执行，旧运行不能消费新配置', async t => {
  const f = await fixture(t, cycle, new Date('2026-11-03T10:00').getTime());
  const scheduler = f.create();
  await scheduler.refresh();
  await scheduler.triggerNow(f.target.id);
  await f.workflows.save({ ...f.target, trigger: { mode: 'once', at: '2026-11-03 09:00', enabled: true } });
  await scheduler.refresh();
  await waitForFire(scheduler);
  assert.equal(f.engine.started.length, 2);
  assert.equal((await f.tasks().list())[0].lastSource, 'schedule');
});

test('立即触发并发请求只启动一个实例', async t => {
  const f = await fixture(t, cycle);
  const scheduler = f.create();
  await scheduler.refresh();
  const results = await Promise.allSettled([scheduler.triggerNow(f.target.id), scheduler.triggerNow(f.target.id)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.engine.started.length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'RUN_BUSY');
});

test('定时领取在途时停用或停止插件，不执行旧任务、不恢复旧排期', async t => {
  for (const action of ['disable', 'stop']) {
    const f = await fixture(t, cycle);
    const scheduler = f.create();
    await scheduler.refresh();
    const due = scheduler.planned()[0].nextAt;
    let entered;
    let release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const claim = f.tasks().claim.bind(f.tasks());
    f.tasks().claim = async (...args) => {
      await claim(...args);
      entered();
      await hold;
    };
    t.after(release);
    f.time(due);
    await waiting;
    if (action === 'disable') {
      await f.workflows.save({ ...f.target, trigger: { ...cycle, enabled: false } });
      await scheduler.refresh();
    } else {
      scheduler.stop();
    }
    release();
    await waitForFire(scheduler);
    assert.equal(f.engine.started.length, 0);
    assert.deepEqual(scheduler.planned(), []);
  }
});

test('立即触发读取期间停止插件，读取恢复后不能再启动', async t => {
  const f = await fixture(t, cycle);
  const scheduler = f.create();
  await scheduler.refresh();
  let entered;
  let release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  t.after(release);
  f.workflows.read = async () => { entered(); await hold; return f.target; };
  const start = scheduler.triggerNow(f.target.id);
  await waiting;
  scheduler.stop();
  release();
  await assert.rejects(start, { code: 'PLUGIN_STOPPING' });
  assert.equal(f.engine.started.length, 0);
  await assert.rejects(scheduler.triggerNow(f.target.id), { code: 'PLUGIN_STOPPING' });
});

test('删除期间拒绝新触发请求，删除失败释放后仍可正常触发', async t => {
  const f = await fixture(t, cycle);
  const scheduler = f.create();
  await scheduler.refresh();
  const release = scheduler.invalidate(f.target.id);
  await assert.rejects(scheduler.triggerNow(f.target.id), { code: 'TRIGGER_CHANGED' });
  release();
  assert.equal((await scheduler.triggerNow(f.target.id)).status, 'succeeded');
});
