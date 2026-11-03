import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const start = source.slice(source.indexOf('async function startWorkflow()'), source.indexOf('async function runWorkflow('));

test('每日、周期、单次时钟按钮都可开启和关闭定时，切换不手动执行', async () => {
  for (const mode of ['daily', 'interval', 'once']) {
    const workflow = { trigger: { mode, enabled: false } };
    const state = { dirty: true, workflows: [workflow], triggers: [] };
    const calls = [];
    const context = vm.createContext({ current: () => state.workflows[0], state, setStatus: message => calls.push(message), render: () => {},
      invoke: async (method, input) => {
        if (method === 'triggers.setEnabled') {
          calls.push(input.enabled);
          return { ...workflow, trigger: { mode, enabled: input.enabled } };
        }
        return [{ workflowId: workflow.id, enabled: state.workflows[0].trigger.enabled, nextAt: 1000 }];
      },
      saveWorkflow: async () => { calls.push('save'); state.dirty = false; },
      runWorkflow: async () => calls.push('run') });
    vm.runInContext(start, context);
    await context.startWorkflow();
    await context.startWorkflow();
    assert.equal(state.workflows[0].trigger.enabled, false);
    assert.deepEqual(calls.filter(call => typeof call === 'boolean'), [true, false]);
    assert.equal(calls.filter(call => call === 'save').length, 1);
    assert.equal(calls.includes('run'), false);
  }
});

test('仅手动工作流仍立即运行一次', async () => {
  let runs = 0;
  const context = vm.createContext({ current: () => ({ trigger: { mode: 'manual' } }), runWorkflow: async () => { runs += 1; } });
  vm.runInContext(start, context);
  await context.startWorkflow();
  assert.equal(runs, 1);
});

test('开启定时保存失败后保留待保存状态，重试不能误报已开启', async () => {
  const workflow = { trigger: { mode: 'interval', enabled: false } };
  const state = { dirty: true, triggers: [] };
  let attempts = 0;
  const context = vm.createContext({ current: () => workflow, state,
    setStatus: () => assert.fail('保存失败不能显示开启成功'),
    saveWorkflow: async () => { attempts += 1; throw Error('保存失败'); } });
  vm.runInContext(start, context);
  await assert.rejects(context.startWorkflow(), /保存失败/);
  assert.equal(state.dirty, true);
  await assert.rejects(context.startWorkflow(), /保存失败/);
  assert.equal(attempts, 2);
});

test('关闭定时保留本窗口未保存的编辑，不执行保存或停止本次运行', async () => {
  const workflow = { id: 'wf', name: '未保存的名称', trigger: { mode: 'daily', enabled: true } };
  const state = { dirty: true, workflows: [workflow], triggers: [{ workflowId: 'wf', enabled: true }], run: { status: 'waiting' } };
  const calls = [];
  const context = vm.createContext({ current: () => workflow, state, render() {}, setStatus() {},
    saveWorkflow: () => assert.fail('关闭定时不能提交本地草稿'),
    invoke: async (method, input) => {
      calls.push(method);
      if (method === 'triggers.setEnabled') {
        assert.equal(input.enabled, false);
        return { ...workflow, name: '后台原名称', trigger: { mode: 'daily', enabled: false } };
      }
      return [{ workflowId: 'wf', enabled: false, nextAt: null }];
    } });
  vm.runInContext(start, context);
  await context.startWorkflow();
  assert.equal(state.workflows[0].name, '未保存的名称');
  assert.equal(state.workflows[0].trigger.enabled, false);
  assert.equal(state.dirty, true);
  assert.equal(state.run.status, 'waiting');
  assert.deepEqual(calls, ['triggers.setEnabled', 'triggers.next']);
});
