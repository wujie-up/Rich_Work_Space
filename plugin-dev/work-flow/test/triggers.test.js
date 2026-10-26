import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { Workflows } from '../src/main/common/workflows.js';
import { normalizeTrigger, nextRunAt, Scheduler, parseLocal } from '../src/main/common/triggers.js';

const PLUGIN_ID = 'work-flow';

async function store(t) {
  const root = await mkdtemp(join(tmpdir(), 'wf-trigger-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  return new Storage(root);
}

const workflow = (trigger = {}) => ({ name: '定时流程', nodes: [{ id: 'a', type: 'text.input', params: { content: 'x' } }],
  edges: [], trigger });

test('默认是仅手动，且不产生任何自动运行', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const saved = await workflows.save(workflow());
  assert.deepEqual(saved.trigger, { mode: 'manual', at: '', every: 1, unit: 'minute', enabled: false });
  assert.equal(nextRunAt(saved.trigger, Date.now()), null);
});

test('固定时间触发在将来生效，过去则不再触发', () => {
  const future = '2030-01-02 09:30:00';
  const trigger = normalizeTrigger({ mode: 'once', at: future });
  assert.equal(trigger.enabled, true);
  assert.equal(nextRunAt(trigger, Date.parse('2030-01-02T09:29:59')), parseLocal(future));
  assert.equal(nextRunAt(trigger, parseLocal(future)), null);
  assert.equal(nextRunAt(trigger, Date.parse('2030-01-02T09:30:01')), null, '错过的固定时间不补跑');
});

test('固定周期支持秒/分/时/天', () => {
  const from = parseLocal('2026-03-01 10:00:00');
  assert.equal(nextRunAt({ mode: 'interval', every: 30, unit: 'second', enabled: true }, from), from + 30000);
  assert.equal(nextRunAt({ mode: 'interval', every: 5, unit: 'minute', enabled: true }, from), from + 300000);
  assert.equal(nextRunAt({ mode: 'interval', every: 2, unit: 'hour', enabled: true }, from), from + 7200000);
  assert.equal(nextRunAt({ mode: 'interval', every: 1, unit: 'day', enabled: true }, from), from + 86400000);
});

test('按月与按年周期保留日并夹到当月最后一天', () => {
  const jan31 = parseLocal('2026-01-31 08:00:00');
  assert.equal(new Date(nextRunAt({ mode: 'interval', every: 1, unit: 'month', enabled: true }, jan31, jan31)).getMonth(), 1);
  assert.equal(new Date(nextRunAt({ mode: 'interval', every: 1, unit: 'month', enabled: true }, jan31, jan31)).getDate(), 28,
    '1 月 31 日加一个月落在 2 月最后一天');
  const leap = parseLocal('2024-02-29 08:00:00');
  const yearly = nextRunAt({ mode: 'interval', every: 1, unit: 'year', enabled: true }, leap, leap);
  assert.equal(new Date(yearly).getFullYear(), 2025);
  assert.equal(new Date(yearly).getDate(), 28);
});

test('插件未运行期间错过的周期会被跳过，不回放积压', () => {
  const anchor = parseLocal('2026-01-01 00:00:00');
  const now = parseLocal('2026-01-01 00:05:00');
  const next = nextRunAt({ mode: 'interval', every: 1, unit: 'minute', enabled: true }, now, anchor);
  assert.equal(next, now + 60000, '只排下一次，不补前面 4 次');
});

test('非法触发配置会被拒绝', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  await assert.rejects(workflows.save(workflow({ mode: 'once', at: '明天上午' })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(workflows.save(workflow({ mode: 'interval', every: 0, unit: 'minute' })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(workflows.save(workflow({ mode: 'interval', every: 2, unit: 'fortnight' })), { code: 'INVALID_ARGUMENT' });
});

function fakeEngine() {
  const started = [];
  return { started, active: false, activeRun: () => false,
    start: async workflow => { started.push(workflow.id); return { id: `run-${started.length}` }; } };
}

test('调度器按周期自动触发，并在停止后不再触发', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const target = await workflows.save(workflow({ mode: 'interval', every: 1, unit: 'second', enabled: true }));
  const engine = fakeEngine();
  const scheduler = new Scheduler({ workflows, engine, logger: () => {}, pluginId: PLUGIN_ID });
  await scheduler.refresh();
  await new Promise(resolve => setTimeout(resolve, 2400));
  assert.ok(engine.started.length >= 1, `应自动触发，实际 ${engine.started.length} 次`);
  assert.equal(engine.started[0], target.id);
  scheduler.stop();
  const seen = engine.started.length;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(engine.started.length, seen, '停止后不应再触发');
});

test('上一次运行未结束时跳过本次触发', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  await workflows.save(workflow({ mode: 'interval', every: 1, unit: 'second', enabled: true }));
  const engine = fakeEngine();
  engine.activeRun = () => true;
  const scheduler = new Scheduler({ workflows, engine, logger: () => {}, pluginId: PLUGIN_ID });
  await scheduler.refresh();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(engine.started.length, 0);
  scheduler.stop();
});

test('超过单次定时上限的周期只重新排期，不会提前触发', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  await workflows.save(workflow({ mode: 'interval', every: 1, unit: 'month', enabled: true }));
  const engine = fakeEngine();
  // A tiny timer ceiling stands in for the ~24 day limit of setTimeout.
  const scheduler = new Scheduler({ workflows, engine, logger: () => {}, pluginId: PLUGIN_ID, maxDelay: 100 });
  await scheduler.refresh();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(engine.started.length, 0, '提前唤醒只能重新排期');
  assert.equal(scheduler.planned().length, 1, '仍在等待真正的触发时间');
  scheduler.stop();
});

test('排期读取失败不会抛出未处理拒绝', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const target = await workflows.save(workflow({ mode: 'interval', every: 1, unit: 'second', enabled: true }));
  const engine = fakeEngine();
  const scheduler = new Scheduler({ workflows, engine, logger: () => {}, pluginId: PLUGIN_ID });
  const rejections = [];
  const onRejection = error => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  await scheduler.refresh();
  workflows.list = async () => { throw Error('数据文件正被写入'); };
  await new Promise(resolve => setTimeout(resolve, 1600));
  scheduler.stop();
  assert.deepEqual(rejections, [], '插件进程不能因为排期失败而崩溃');
});

test('改为仅手动或停用后不再排定下次运行', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const target = await workflows.save(workflow({ mode: 'interval', every: 1, unit: 'second', enabled: true }));
  const engine = fakeEngine();
  const scheduler = new Scheduler({ workflows, engine, logger: () => {}, pluginId: PLUGIN_ID });
  assert.equal((await scheduler.refresh()).length, 1);
  await workflows.save({ ...target, trigger: { mode: 'interval', every: 1, unit: 'second', enabled: false } });
  assert.equal((await scheduler.refresh()).length, 0);
  assert.equal((await scheduler.list())[0].nextAt, null);
  scheduler.stop();
});
