import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packPackage } from '../../../../desk/src/main/common/plugin-package.js';
import { withPackageSource } from '../../../../desk/src/main/common/plugin-package.js';
import { launch } from '../../../../desk/test/electron/helpers.js';

// Poll RPC results outside the renderer so every check observes the resolved backend value.
async function until(check) {
  const deadline = Date.now() + 30000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, '后台状态未在 30 秒内达到预期');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Only the transport is replaced. The packaged desktop, UI, queue, engine and capability routing remain real.
async function fixture(root) {
  const source = join(root, 'workflow');
  await mkdir(source);
  for (const file of ['plugin.json', 'package.json', 'src', 'dist', 'ico', 'title.md']) {
    await cp(resolve('plugin-dev/work-flow', file), join(source, file), { recursive: true });
  }
  if (process.env.WORKFLOW_OLD_RENDERER) {
    await withPackageSource(resolve(process.env.WORKFLOW_OLD_RENDERER), source => cp(join(source, 'dist'), join(root, 'workflow/dist'), { recursive: true }));
  }
  const receiver = `
export const receivers = new Map();
export const stats = {starts:0,stops:0,resumes:0};
export function createWechatReceiver(options) {
  return {async start() { stats.starts++; receivers.set(options.connection.id,options);
    options.onStatus({state:'scan',qrDataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII='}); },
    async stop() { stats.stops++; receivers.delete(options.connection.id); }};
}
`;
  await writeFile(join(source, 'src/main/common/message-wechat.js'), receiver);
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  manifest.main = 'fixture.js';
  await writeFile(join(source, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'fixture.js'), `
import {activate as original} from './src/main/common/index.js';
export {deactivate} from './src/main/common/index.js';
import {receivers,stats} from './src/main/common/message-wechat.js';
export async function activate(context) {
  context.methods.register('probe.stats',()=>stats);
  context.methods.register('probe.message',async input=>receivers.get(input.connectionId)?.onMessage({channel:'wechat',
    messageId:input.messageId,connectionId:input.connectionId,chat:{id:'chat-id',type:'group',name:'测试群'},
    sender:{id:'user-id',name:'测试用户'},text:input.text,sentAt:Date.now(),receivedAt:Date.now()}));
  context.methods.register('probe.history', async () => {
    const key = 'plugin-data/work-flow/message-queue.json';
    const data = await context.storage.readJson(key);
    data.items[0].status = 'interrupted'; data.items[1].status = 'invalid';
    await context.storage.writeJson(key,data); context.emit('messages.changed',{});
  });
  context.methods.register('probe.activity', input=>receivers.get(input.connectionId)?.onActivity(input.activity));
  context.methods.register('probe.status',input=>receivers.get(input.connectionId)?.onStatus(input.status));
  await original({...context,methods:{register(name,handler,options) {
    context.methods.register(name,(...args)=>{ if(name==='runs.resume') {stats.resumes++;} return handler(...args);},options);
  }}});
}
`);
  const file = join(root, 'workflow.plg');
  await packPackage(source, file);
  return file;
}
async function install(app, page, path) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path);
  await page.evaluate(() => workDesk.plugins.install());
}

test('最新 DeckPg：消息节点分类、连接配置、事件队列、多窗口观察和最后窗口停止', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-messages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = await fixture(root);
  const { app, page, logs } = await launch(t, { openPlugin: false });
  t.after(async () => { await mkdir(resolve('.test-results/work-flow'), { recursive: true });
    await writeFile(resolve('.test-results/work-flow/messages.log'), logs.join('')); });
  const call = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  await page.evaluate(async () => {
    const record = (await workDesk.plugins.list()).find(item => item.id === 'work-flow');
    if (record && record.state !== 'uninstalled') {
      const preview = await workDesk.plugins.preview(record.id, 'remove');
      await workDesk.plugins.remove(record.id, 'clear', preview.confirmationToken);
    }
  });
  await install(app, page, archive);
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  let frame = page.frameLocator('iframe.plugin-view:visible').first();
  await frame.locator('#message-connections').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('#message-connections').getAttribute('open'), null);
  await frame.locator('#message-connections > summary').click();
  await frame.locator('#message-new').click();
  await frame.locator('#message-name').fill('<img src=x onerror=alert(1)>微信');
  await frame.locator('#message-token').fill('fixture-secret-token');
  await frame.locator('#message-save').click();
  await frame.locator('[data-message-edit]').waitFor();
  const connection = (await call('messages.connections.list'))[0];
  assert.doesNotMatch(await frame.locator('#message-panel').innerHTML(), /fixture-secret-token|<img src=x/);
  await frame.locator('[data-message-edit]').click();
  assert.equal(await frame.locator('#message-token').inputValue(), '');
  await frame.locator('#message-save').click();
  assert.equal((await call('messages.connections.list'))[0].hasSecret, true);
  await call('messages.connections.save', { name: '飞书连接', channel: 'feishu', appId: 'fixture', appSecret: 'secret' });
  await frame.locator('#message-refresh').click();
  await frame.locator('#new-workflow').click();
  await frame.locator('#workflow-name').fill('群消息自动处理');
  await frame.locator('#node-category').selectOption('input');
  assert.equal(await frame.locator('#node-capability option[value^="message."]').count(), 2);
  await frame.locator('#node-category').selectOption('process');
  assert.equal(await frame.locator('#node-capability option[value^="message."]').count(), 0);
  await frame.locator('#node-category').selectOption('input');
  await frame.locator('#node-capability').selectOption('message.wechat');
  await frame.locator('#add-node').click();
  assert.equal(await frame.locator('[data-param="connectionId"] option').count(), 2);
  await frame.locator('.inspector details').filter({ has: frame.locator('#triggers') }).locator('summary').click();
  await frame.locator('#trigger-mode').selectOption('message');
  assert.equal(await frame.locator('#trigger-enabled').isChecked(), false);
  assert.equal(await frame.locator('#trigger-enabled').isDisabled(), true);
  await frame.locator('[data-param="connectionId"]').selectOption(connection.id);
  assert.equal(await frame.locator('#trigger-enabled').isDisabled(), false);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status').filter({ hasText: '开启消息监听' }).waitFor();
  await frame.locator('#trigger-enabled').check();
  await frame.locator('#save').click();
  await frame.locator('.message-qr').waitFor();
  assert.match(await frame.locator('.message-qr').getAttribute('src'), /^data:image\/png;base64,/);
  const workflow = (await call('workflows.list')).find(item => item.name === '群消息自动处理');
  await call('probe.message', { connectionId: connection.id, messageId: 'one', text: '<script>alert(1)</script> hello' });
  await frame.locator('.message-queue-item').filter({ hasText: '已完成' }).waitFor();
  assert.equal((await call('runs.list', workflow.id)).length, 1);
  await call('probe.activity', { connectionId: connection.id, activity: { kind: 'ignored', reason: 'self-or-non-text' } });
  await call('probe.activity', { connectionId: connection.id, activity: { kind: 'rejected', reason: 'invalid-or-oversize' } });
  await frame.locator('.message-connection').filter({ hasText: '忽略 1 · 拒收 1' }).waitFor();
  assert.match(await frame.locator('.message-connection').first().innerText(), /订阅 1 · 收到 1 · 入队 1/);
  assert.match(await frame.locator('.message-connection').first().innerText(), /最近消息 one · 会话 chat-id/);
  assert.equal((await call('probe.stats')).resumes, 0);
  await call('probe.status', { connectionId: connection.id, status: { state: 'error', error: '连接异常' } });
  await frame.locator('#message-panel').filter({ hasText: '连接异常' }).waitFor();
  await page.locator('.shelf-app[data-plugin="work-flow"]').getByRole('button', { name: '新建窗口', exact: true }).click({ force: true });
  await page.waitForFunction(() => document.querySelectorAll('iframe.plugin-view').length === 2);
  await call('probe.message', { connectionId: connection.id, messageId: 'two', text: '第二条消息' });
  await until(async () => (await call('runs.list', workflow.id)).length === 2);
  assert.equal((await call('probe.stats')).starts, 1);
  assert.equal((await call('probe.stats')).resumes, 0);
  await mkdir(resolve('.test-results/work-flow'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/work-flow/messages-window.png') });
  await page.locator('.application-window').last().getByRole('button', { name: '关闭窗口', exact: true }).click();
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.equal((await call('probe.stats')).stops, 0);
  frame = page.frameLocator('iframe.plugin-view:visible').first();
  await frame.locator('body').evaluate(() => {
    window.messageConfirmations = [];
    window.confirm = message => { window.messageConfirmations.push(message); return true; };
  });
  const confirmations = () => frame.locator('body').evaluate(() => window.messageConfirmations);
  await frame.locator('[data-message-retry]').first().click();
  await until(async () => (await call('runs.list', workflow.id)).length === 3);
  assert.ok((await confirmations()).some(text => text.includes('外部')));
  await until(async () => (await call('messages.queue.list', workflow.id)).every(item => item.status === 'succeeded'));
  await call('probe.history');
  await frame.locator('#message-refresh').click();
  await frame.locator('.message-queue-item', { hasText: '中断，需核对外部结果' }).waitFor();
  await frame.locator('.message-queue-item', { hasText: '配置已变化' }).waitFor();
  await frame.locator('#message-clear').click();
  await frame.locator('.message-queue-item').first().waitFor({ state: 'detached' });
  assert.ok((await confirmations()).some(text => text.includes('清空')));
  await page.screenshot({ path: resolve('.test-results/work-flow/messages-config.png') });
  await page.getByRole('button', { name: '平铺到桌面', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  assert.ok(await frame.locator('body').evaluate(body => body.scrollWidth <= innerWidth), '窄窗口不应横向溢出');
  await page.screenshot({ path: resolve('.test-results/work-flow/messages-tiled.png') });
  await page.locator('.application-window').getByRole('button', { name: '关闭窗口', exact: true }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true });
  await page.waitForFunction(() => document.querySelector('dialog button[aria-label="关闭"]')?.title === '关闭');
  await confirm.click();
  await page.locator('.application-window').waitFor({ state: 'detached' });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  frame = page.frameLocator('iframe.plugin-view:visible').first();
  await frame.locator('#message-connections').waitFor({ state: 'attached' });
  assert.equal((await call('messages.connections.list')).length, 2);
});

async function agentFixture(root) {
  const source = join(root, 'agent');
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'message-test-agent', name: '消息测试 Agent', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: true, main: 'index.mjs' }));
  await writeFile(join(source, 'index.mjs'), `
export function deactivate() {}
export async function activate(context) {
  const tasks = new Map();
  const stats = {starts:0,reads:0,responses:0,cancelled:0};
  context.methods.register('probe.stats',()=>stats);
  for (const [id,handler] of [
    ['agent.task.start.v1',input=>{stats.starts++; tasks.set(input.taskKey,{state:'running',requests:[{id:'country',
      method:'item/tool/requestUserInput',params:{questions:[{id:'country',question:'需要分析哪个国家？'}]}}]}); return {state:'running'};}],
    ['agent.task.read.v1',input=>{stats.reads++; return tasks.get(input.taskKey);}],
    ['agent.task.respond.v1',input=>{if(input.answers.country!=='中国'){throw Error('回答不正确');}
      stats.responses++; tasks.set(input.taskKey,{state:'succeeded',output:'中国消息分析完成'}); return {accepted:true};}],
    ['agent.task.cancel.v1',input=>{stats.cancelled++; tasks.set(input.taskKey,{state:'cancelled'}); return {state:'cancelled'};}]
  ]) {
    await context.capabilities.register({id,version:1,title:id,description:id,state:'ready',effects:['workspace.read'],confirmation:'policy',
      inputSchema:{type:'object'},outputSchema:{type:'object'},execution:{timeoutMs:30000,cancellable:true,retry:'never'}},handler);
  }
}
`);
  const archive = join(root, 'agent.plg');
  await packPackage(source, archive);
  return archive;
}

test('最新 DeckPg：消息 Agent 后台轮询、多窗口不重复启动、人工回答和停止协调', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-message-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowPackage = await fixture(root);
  const providerPackage = await agentFixture(root);
  const { app, page, logs } = await launch(t, { openPlugin: false });
  t.after(async () => { await mkdir(resolve('.test-results/work-flow'), { recursive: true });
    await writeFile(resolve('.test-results/work-flow/message-agent.log'), logs.join('')); });
  const call = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const stats = () => page.evaluate(() => workDesk.plugins.invoke('message-test-agent', 'probe.stats', []));
  await page.evaluate(async () => {
    const record = (await workDesk.plugins.list()).find(item => item.id === 'work-flow');
    if (record && record.state !== 'uninstalled') {
      const preview = await workDesk.plugins.preview(record.id, 'remove');
      await workDesk.plugins.remove(record.id, 'clear', preview.confirmationToken);
    }
  });
  await install(app, page, workflowPackage);
  await install(app, page, providerPackage);
  await page.evaluate(() => workDesk.plugins.enable('message-test-agent'));
  const connection = await call('messages.connections.save', { name: '消息分析', channel: 'wechat', token: 'fake-token' });
  const workflow = await call('workflows.save', { name: '消息 Agent 人工确认', trigger: { mode: 'message', enabled: true }, nodes: [
    { id: 'entry', type: 'message.wechat', title: '微信消息', params: { connectionId: connection.id } },
    { id: 'agent', type: 'agent.review', title: 'Agent 分析', x: 300,
      params: { providerId: 'message-test-agent', input: '{{entry.text}}', instructions: '分析消息' } }
  ], edges: [{ from: 'entry', to: 'agent' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  let frame = page.frameLocator('iframe.plugin-view:visible').first();
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await call('probe.message', { connectionId: connection.id, messageId: 'agent-one', text: '分析这个问题' });
  await frame.locator('#request-plan-0').waitFor();
  await page.locator('.shelf-app[data-plugin="work-flow"]').getByRole('button', { name: '新建窗口', exact: true }).click({ force: true });
  const second = page.locator('.application-window').last();
  const otherFrame = second.frameLocator('iframe');
  await otherFrame.locator(`[data-workflow="${workflow.id}"]`).click({ force: true });
  await otherFrame.locator('#request-plan-0').waitFor();
  await call('probe.message', { connectionId: connection.id, messageId: 'agent-two', text: '等待上一条完成' });
  await until(async () => (await stats()).reads >= 3);
  assert.equal((await stats()).starts, 1);
  assert.equal((await stats()).responses, 0);
  assert.equal((await call('probe.stats')).resumes, 0);
  assert.equal((await call('messages.queue.list', workflow.id)).filter(item => item.status === 'pending').length, 1);
  await otherFrame.locator('#request-plan-0').fill('{"country":"中国"}');
  await otherFrame.locator('[data-answer="0"]').click({ force: true });
  await until(async () => (await stats()).starts === 2);
  assert.equal((await stats()).responses, 1);
  await until(async () => (await call('runs.list', workflow.id)).filter(run => run.status === 'succeeded').length === 1);
  await second.getByRole('button', { name: '关闭窗口', exact: true }).click({ force: true });
  frame = page.frameLocator('iframe.plugin-view:visible').first();
  await frame.locator('#request-plan-0').waitFor();
  await page.locator('.application-window').getByRole('button', { name: '最小化', exact: true }).click();
  const reads = (await stats()).reads;
  await until(async () => (await stats()).reads > reads);
  const preview = await page.evaluate(() => workDesk.plugins.preview('work-flow', 'disable'));
  assert.match(JSON.stringify(preview), /消息|等待/);
  await page.evaluate(token => workDesk.plugins.disable('work-flow', token), preview.confirmationToken);
  assert.equal((await stats()).cancelled, 1);
  assert.equal(await page.locator('.application-window').count(), 0);
  assert.equal((await stats()).starts, 2);
});
