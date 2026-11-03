import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import vm from 'node:vm';
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

test('每日北京时间配置保存后可重新读取，且停用后不排期', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const trigger = { mode: 'daily', at: '10:00', timezone: 'Asia/Shanghai', enabled: true };
  const saved = await workflows.save(workflow(trigger));
  assert.deepEqual(saved.trigger, trigger);
  assert.deepEqual((await workflows.read(saved.id)).trigger, trigger);
  assert.deepEqual(normalizeTrigger({ mode: 'daily', at: '10:00' }), trigger);
  assert.equal(nextRunAt({ ...trigger, enabled: false }, Date.parse('2026-11-03T00:00:00Z')), null);
});

test('每日触发只接受合法的 HH:mm 与北京时间', () => {
  for (const at of ['', '9:00', '24:00', '10:60', '10:00:00', ' 10:00', '10:00 ']) {
    assert.throws(() => normalizeTrigger({ mode: 'daily', at }), { code: 'INVALID_ARGUMENT' }, at);
  }
  assert.throws(() => normalizeTrigger({ mode: 'daily', at: '10:00', timezone: 'UTC' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(normalizeTrigger({ mode: 'daily', at: '00:00' }).at, '00:00');
  assert.equal(normalizeTrigger({ mode: 'daily', at: '23:59' }).at, '23:59');
});

test('每日北京时间在当日时点之前排今天，到点和错过后只排明天并忽略周期锚点', () => {
  const trigger = { mode: 'daily', at: '10:00', timezone: 'Asia/Shanghai', enabled: true };
  const today = Date.parse('2026-11-03T02:00:00Z');
  const tomorrow = Date.parse('2026-11-04T02:00:00Z');
  assert.equal(nextRunAt(trigger, today - 1), today);
  assert.equal(nextRunAt(trigger, today), tomorrow);
  assert.equal(nextRunAt(trigger, today + 1, Date.parse('2025-01-01T01:23:00Z')), tomorrow);
  assert.equal(nextRunAt(trigger, Date.parse('2026-12-31T16:00:00Z')), Date.parse('2027-01-01T02:00:00Z'));
});

test('每日时点计算不受宿主本地时区及夏令时影响', () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
      process.env.TZ = timezone;
      const trigger = { mode: 'daily', at: '10:00', timezone: 'Asia/Shanghai', enabled: true };
      assert.equal(nextRunAt(trigger, Date.parse('2026-03-08T01:59:59Z')), Date.parse('2026-03-08T02:00:00Z'));
      assert.equal(nextRunAt(trigger, Date.parse('2026-03-08T02:00:00Z')), Date.parse('2026-03-09T02:00:00Z'));
    }
  } finally {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  }
});

test('每日触发界面提供时间控件，修改后保存并重新打开保留北京时间', async t => {
  const source = await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const controls = Object.fromEntries(['mode', 'at', 'every', 'unit', 'enabled'].map(name => [`#trigger-${name}`, {}]));
  const container = { innerHTML: '', querySelector: selector => controls[selector] };
  let target = workflow();
  const context = vm.createContext({ current: () => target, escape: String, renderStatus: () => {},
    state: { dirty: false, connections: [], triggers: [], triggerOptions: { modes: [], units: [] } },
    document: { querySelector: () => container } });
  vm.runInContext(source.match(/const MODE_LABELS = [^\n]+/)[0]
    + source.slice(source.indexOf('function renderTriggers()'), source.indexOf('function paramHtml(')), context);
  context.renderTriggers();
  assert.match(container.innerHTML, /value="daily"[^>]*>每日固定时间（北京时间）/);
  controls['#trigger-mode'].onchange({ target: { value: 'daily' } });
  assert.match(container.innerHTML, /id="trigger-at" type="time"/);
  assert.match(container.innerHTML, /value="10:00"/);
  controls['#trigger-at'].value = '09:45';
  controls['#trigger-at'].onchange();
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const saved = await workflows.save(target);
  target = await workflows.read(saved.id);
  context.renderTriggers();
  assert.deepEqual(target.trigger, { mode: 'daily', at: '09:45', timezone: 'Asia/Shanghai', enabled: true });
  assert.match(container.innerHTML, /value="09:45"/);
  assert.match(container.innerHTML, /value="daily" selected/);
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

test('读取排期和保存其他工作流不会推迟首次触发，修改周期才重新排期', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  const target = await workflows.save(workflow({ mode: 'interval', every: 30, unit: 'minute', enabled: true }));
  let now = 1000000;
  const scheduler = new Scheduler({ workflows, engine: fakeEngine(), logger: () => {}, pluginId: PLUGIN_ID, now: () => now });
  t.after(() => scheduler.stop());
  await scheduler.refresh();
  const due = scheduler.planned()[0].nextAt;
  now += 600000;
  assert.equal((await scheduler.list())[0].nextAt, due);
  await workflows.save(workflow());
  await scheduler.refresh();
  assert.equal(scheduler.planned()[0].nextAt, due);
  await workflows.save({ ...target, trigger: { ...target.trigger, every: 15 } });
  await scheduler.refresh();
  assert.equal(scheduler.planned()[0].nextAt, now + 900000);
});

test('长周期提前唤醒不会推迟真正的触发时间', async t => {
  const workflows = new Workflows({ storage: await store(t), pluginId: PLUGIN_ID });
  await workflows.save(workflow({ mode: 'interval', every: 1, unit: 'month', enabled: true }));
  const scheduler = new Scheduler({ workflows, engine: fakeEngine(), logger: () => {}, pluginId: PLUGIN_ID, maxDelay: 20 });
  t.after(() => scheduler.stop());
  await scheduler.refresh();
  const due = scheduler.planned()[0].nextAt;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(scheduler.planned()[0].nextAt, due);
});

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

test('关闭期间未完成的配置读取与启动回调不能重新触发或恢复定时器', { timeout: 2000 }, async t => {
  for (const stopDuring of ['read', 'start']) {
    let now = 0;
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const target = { id: 'monitor', trigger: { mode: 'interval', every: 1, unit: 'second', enabled: true } };
    const hold = () => new Promise(resolve => { release = resolve; entered(); });
    const engine = fakeEngine();
    const start = engine.start;
    engine.start = async value => {
      if (stopDuring === 'start') { await hold(); }
      return start(value);
    };
    const scheduler = new Scheduler({ now: () => now, maxDelay: 20, engine, pluginId: PLUGIN_ID, logger: () => {},
      workflows: { list: async () => [target], read: async () => stopDuring === 'read' ? hold() : target } });
    t.after(() => scheduler.stop());
    await scheduler.refresh();
    now = 1000;
    await waiting;
    scheduler.stop();
    release(target);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(scheduler.planned(), [], '关闭后不能恢复排期');
    assert.equal(engine.started.length, stopDuring === 'read' ? 0 : 1, '关闭前尚未启动的任务不得再启动');
  }
});
