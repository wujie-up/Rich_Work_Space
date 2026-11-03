import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from './helpers.js';

test('packaged desktop approval survives execution budget and still supports denial and cancellation', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t);
  const directory = join(data, 'approval-probe');
  await mkdir(directory);
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id: 'approval-probe', name: 'Approval probe',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: false,
    background: 'service', main: 'index.mjs' }));
  await writeFile(join(directory, 'index.mjs'), `export async function activate(c) {
    c.methods.register('probe.ready',()=>true);
    await c.capabilities.register({id:'probe.write',version:1,title:'Approval timing probe',description:'Write test data',
      inputSchema:{type:'object'},outputSchema:{type:'object'},effects:['workspace.write'],confirmation:'always',
      execution:{timeoutMs:500,cancellable:true,retry:'never'}},async input=>input);
  } export function deactivate() {}`);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, directory);
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(() => workDesk.plugins.invoke('approval-probe', 'probe.ready'));
  const caller = join(data, 'approval-caller');
  await mkdir(caller);
  await writeFile(join(caller, 'plugin.json'), JSON.stringify({ id: 'approval-caller', name: 'Approval caller',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: false,
    background: 'service', main: 'index.mjs' }));
  await writeFile(join(caller, 'index.mjs'), `export function activate(c) {
    c.methods.register('probe.call',async()=> {
      const catalog = await c.capabilities.discover({id:'probe.write'});
      return c.capabilities.invoke(catalog.providers[0].handle,{});
    });
    c.methods.register('probe.get',id=>c.capabilities.getInvocation(id));
    c.methods.register('probe.cancel',id=>c.capabilities.cancel(id));
  } export function deactivate() {}`);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, caller);
  await page.evaluate(() => workDesk.plugins.install());
  const invoke = () => page.evaluate(() => workDesk.plugins.invoke('approval-caller', 'probe.call'));
  const get = id => page.evaluate(id => workDesk.plugins.invoke('approval-caller', 'probe.get', [id]), id);
  let task = await invoke();
  await page.getByRole('button', { name: '允许', exact: true }).waitFor();
  await delay(700);
  assert.equal((await get(task.invocationId)).approvalRequired, true);
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('approval-caller', 'probe.get', [id])).state === 'succeeded', task.invocationId);
  task = await invoke();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('approval-caller', 'probe.get', [id])).state === 'cancelled', task.invocationId);
  task = await invoke();
  await page.getByRole('button', { name: '允许', exact: true }).waitFor();
  await page.evaluate(id => workDesk.plugins.invoke('approval-caller', 'probe.cancel', [id]), task.invocationId);
  assert.equal((await get(task.invocationId)).state, 'cancelled');
});


test('real workflow resume releases the view deadline before a 32-second approval', { timeout: 90000 }, async t => {
  const { app, page, data, logs } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  t.after(() => writeFile('/tmp/deckpg-legacy-approval.log', logs.join('')));
  const workflow = join(data, 'workflow-package');
  await mkdir(workflow);
  for (const name of ['plugin.json', 'package.json', 'src', 'dist', 'ico']) {
    await cp(resolve('plugin-dev/work-flow', name), join(workflow, name), { recursive: true });
  }
  const provider = join(data, 'workflow-approval-provider');
  await mkdir(provider);
  await writeFile(join(provider, 'plugin.json'), JSON.stringify({ id: 'workflow-approval-provider', name: 'Workflow approval provider',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: false,
    background: 'service', main: 'index.mjs' }));
  await writeFile(join(provider, 'index.mjs'), `export async function activate(c) {
    let starts=0;
    c.methods.register('probe.ready',()=>true);
    c.methods.register('probe.starts',()=>starts);
    for (const id of ['agent.menu.code.start.v1','agent.task.read.v1','agent.task.cancel.v1']) {
      await c.capabilities.register({id,version:1,title:'Workflow approval timing',description:'Isolated workflow timing test',
        inputSchema:{type:'object'},outputSchema:{type:'object'},effects:id.includes('start')?['workspace.write']:['workspace.read'],
        confirmation:id.includes('start')?'always':'policy',execution:{timeoutMs:1000,cancellable:true,retry:'never'}},async()=> {
          if (id.includes('start')) { starts++; return {state:'running'}; }
          return {state:'succeeded',output:'approval complete'};
        });
    }
  } export function deactivate() {}`);
  for (const directory of [provider, workflow]) {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, directory);
    await page.evaluate(() => workDesk.plugins.install());
  }
  await page.evaluate(() => workDesk.plugins.invoke('workflow-approval-provider', 'probe.ready'));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const saved = await invoke('workflows.save', { name: '32 second approval', nodes: [
    { id: 'source', type: 'text.input', title: 'Input', x: 0, y: 0, params: { content: 'timing test' } },
    { id: 'code', type: 'agent.review', title: 'Code', x: 200, y: 0,
      params: { input: '{{source.text}}', mode: 'code', cwd: data, files: 'probe.txt', providerId: 'workflow-approval-provider' } }
  ], edges: [{ from: 'source', to: 'code' }] });
  const run = await invoke('runs.start', saved.id);
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('work-flow', 'runs.get', [id])).status === 'waiting', run.id);
  const startedAt = Date.now();
  assert.ok(['running', 'waiting'].includes((await invoke('runs.resume', run.id)).status));
  assert.ok(Date.now() - startedAt < 2000, 'resume must return before the human approves');
  await page.getByRole('button', { name: '允许', exact: true }).waitFor();
  // Exceeds both the host view RPC deadline (30s) and capability execution budget (1s).
  await delay(32000);
  await invoke('runs.resume', run.id);
  assert.ok(['running', 'waiting'].includes((await invoke('runs.get', run.id)).status));
  await page.getByRole('button', { name: '允许', exact: true }).click();
  const deadline = Date.now() + 10000;
  while (['waiting', 'running'].includes((await invoke('runs.get', run.id)).status) && Date.now() < deadline) {
    await delay(100);
  }
  assert.equal((await invoke('runs.get', run.id)).status, 'succeeded');
  assert.equal(await page.evaluate(() => workDesk.plugins.invoke('workflow-approval-provider', 'probe.starts')), 1);
  const completed = await invoke('runs.get', run.id);
  assert.ok(Object.values(completed.nodes).some(node => node.output?.output === 'approval complete'), JSON.stringify(completed));
  const cancelled = await invoke('runs.start', saved.id);
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('work-flow', 'runs.get', [id])).status === 'waiting', cancelled.id);
  await invoke('runs.resume', cancelled.id);
  await page.getByRole('button', { name: '允许', exact: true }).waitFor();
  await invoke('runs.cancel', cancelled.id);
  assert.equal((await invoke('runs.get', cancelled.id)).status, 'canceled');
  assert.equal(await page.evaluate(() => workDesk.plugins.invoke('workflow-approval-provider', 'probe.starts')), 1);
});
