import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

// Deterministic provider exercises real host/worker/workflow/UI coordination without paid model calls.
test('latest packaged DeskPG coordinates authorization, sequential questions, loop reuse and archived history', { timeout: 120000 }, async t => {
  const { app, page, data, logs } = await launch(t, { openPlugin: false, prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await mkdir('.test-results/work-flow', { recursive: true });
  t.after(() => writeFile('.test-results/work-flow/agent-coordination.log', logs.join('')));
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('RENDER ERROR', error.stack); });
  const directory = join(data, 'coordination-provider');
  await mkdir(directory);
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id: 'coordination-provider', name: 'Coordination fixture', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: false, background: 'service', main: 'index.mjs' }));
  await writeFile(join(directory, 'index.mjs'), `export async function activate(c) {
    const sessions = new Map();
    const calls = [];
    const parallelStarts = [];
    let releaseParallel;
    const parallelReady = new Promise(resolve => { releaseParallel = resolve; });
    c.methods.register('probe.calls', () => calls);
    c.methods.register('probe.append', ({sessionId, text, completed}) => {
      const record = sessions.get(sessionId);
      record.events.push({sequence:record.events.length+1,method:completed?'item/completed':'item/agentMessage/delta',
        params:completed?{item:{id:'stream',type:'agentMessage',text}}:{itemId:'stream',delta:text},at:Date.now()});
    });
    const read = record => record.name === '实时 Agent' ? {sessionId:record.id,state:'running',requests:[],output:''} : ({ sessionId: record.id, state: !record.name.startsWith('并行审核') && record.turn === 1 && !record.answered ? 'running' : 'succeeded',
      output: JSON.stringify({ passed: record.turn > 1 }), requests: !record.name.startsWith('并行审核') && record.turn === 1 && !record.answered ? [{ id: 1,
        method: record.name === '授权 Agent' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput', params: { command:'fixture-only', questions: record.name === '产品 Agent' ? [
          { id: 'decision', question: '产品：选择场地', options: [{ label: '森林' }, { label: '海洋' }] },
          { id: 'rules', question: '产品：确认回合规则' }] : [{ id: 'decision', question: '开发：确认像素尺寸' }] } }] : [] });
    for (const method of ['start','read','respond','cancel','history','close']) {
      await c.capabilities.register({ id: 'agent.session.'+method+'.v1', version: 1, title: method, description: 'Fixture '+method,
        inputSchema: {type:'object'}, outputSchema: {type:'object'}, effects: ['workspace.'+(['start','respond'].includes(method)?'write':'read')],
        confirmation: 'policy', execution: {timeoutMs:30000,cancellable:true,retry:'never'} }, async input => {
        calls.push({method,...input});
        if (method === 'start') {
          const record = sessions.get(input.sessionId) || {id:'session-'+sessions.size,name:input.name,turn:0,events:[]};
          record.turn++;
          record.answered=false;
          record.events.push({sequence:record.events.length+1,method:'user/message',params:{text:input.prompt},at:Date.now()});
          for(let i=0;i<105;i++) { record.events.push({sequence:record.events.length+1,method:'item/completed',
            params:{item:{type:'agentMessage',text:record.name+' reply '+i}},at:Date.now()}); }
          for(let i=0;i<400;i++) { record.events.push({sequence:record.events.length+1,method:'item/agentMessage/delta',
            params:{itemId:'stream',delta:'连续'},at:Date.now()}); }
          record.events.push({sequence:record.events.length+1,method:'item/completed',
            params:{item:{id:'stream',type:'agentMessage',text:'连续'.repeat(400)}},at:Date.now()});
          sessions.set(record.id,record);
          if (record.name.startsWith('并行审核')) {
            parallelStarts.push(record.id);
            if (parallelStarts.length === 4) { releaseParallel(); }
            await parallelReady;
          }
          return read(record);
        }
        const record = sessions.get(input.sessionId);
        if (method === 'read') { return read(record); }
        if (method === 'respond') { record.answered=true; return {accepted:true}; }
        if (method === 'close') { record.archivedAt=Date.now(); return {archivedAt:record.archivedAt}; }
        if (method === 'history') {
          const events=record.events.filter(event=>event.sequence>(input.afterSequence||0)).slice(0,input.limit||100);
          const nextSequence=events.at(-1)?.sequence||input.afterSequence||0;
          return {events,nextSequence,hasMore:nextSequence<record.events.length};
        }
        return {};
      });
    }
  } export function deactivate() {}`);
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  for (const file of [directory, resolve(`plugin-dev/dist/work-flow-${manifest.version}.plg`)]) {
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
    await page.evaluate(() => workDesk.plugins.install());
  }
  await page.evaluate(async () => {
    await workDesk.plugins.enable('coordination-provider');
    await workDesk.plugins.enable('work-flow');
  });
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const calls = () => page.evaluate(() => workDesk.plugins.invoke('coordination-provider', 'probe.calls'));
  await calls();
  const node = (id, type, params, title = id) => ({ id, type, title, params, x: 20, y: 20 });
  const flow = await invoke('workflows.save', { name: '协作与归档验证', nodes: [
    node('source', 'text.input', { content: '像素宝可梦：六种场地、队列替补' }),
    node('product', 'agent.review', { input: '{{source.text}}', providerId: 'coordination-provider' }, '产品 Agent'),
    node('developer', 'agent.review', { input: '{{product.output}}', providerId: 'coordination-provider', outputFields: '{"passed":"boolean"}' }, '开发 Agent'),
    node('loop', 'flow.loop', { input: '{{developer.output.passed}}', operator: 'equals', expected: 'false', maxIterations: 3 }),
    node('done', 'flow.end', { input: '{{developer.output}}' })
  ], edges: [{from:'source',to:'product'},{from:'product',to:'developer'},{from:'developer',to:'loop'},
    {from:'loop',to:'product',branch:'continue'},{from:'loop',to:'done',branch:'exit'}] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${flow.id}"]`).click();
  await frame.locator('#run').click();
  const popup = page.locator('dialog[data-plugin-message]');
  await popup.getByRole('button', { name: '允许并记住', exact: true }).click();
  await popup.getByText('产品：选择场地', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: '关闭', exact: true }).count(), 0);
  assert.equal(await popup.getByRole('button', { name: '稍后处理', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  assert.ok(await popup.isVisible(), 'required question survives Esc and outside click');
  const centered = await popup.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(centered.x + centered.width / 2 - viewport.width / 2) < 3);
  assert.ok(Math.abs(centered.y + centered.height / 2 - viewport.height / 2) < 3);
  assert.equal(await frame.locator(`[data-workflow="${flow.id}"] [data-activity="waiting"]`).count(), 1);

  assert.doesNotMatch(await popup.innerText(), /确认回合规则/);
  await popup.getByRole('button', { name: '森林', exact: true }).click();
  await popup.getByText('产品：确认回合规则', { exact: true }).waitFor();
  await popup.locator('textarea').fill('替补本回合立即行动');
  await popup.getByRole('button', { name: '确认', exact: true }).click();
  await popup.getByText('开发：确认像素尺寸', { exact: true }).waitFor();
  assert.equal((await calls()).filter(call => call.method === 'respond').length, 1, 'new Agent question is never answered from old native ID');
  await popup.locator('textarea').fill('16 × 16');
  await popup.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor({ timeout: 30000 });
  const run = (await invoke('runs.list', flow.id)).at(-1);
  const activity = await calls();
  const starts = activity.filter(call => call.method === 'start');
  assert.equal(starts.length, 4);
  assert.equal(starts[0].sessionId, undefined);
  assert.equal(starts[2].sessionId, 'session-0');
  assert.equal(starts[3].sessionId, 'session-1');
  assert.equal(activity.filter(call => call.method === 'respond').length, 2);
  assert.equal(activity.filter(call => call.method === 'close').length, 2);
  assert.equal(run.sessions.length, 2);
  assert.ok(run.sessions.every(session => session.archivedAt));
  await frame.locator('#status').click();
  const history = frame.getByRole('dialog', { name: 'Agent 会话记录', exact: true });
  await history.locator('.agent-history-group').nth(1).waitFor();
  const historyBox = await history.boundingBox();
  const frameBox = await page.locator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]').boundingBox();
  assert.ok(Math.abs(historyBox.x + historyBox.width / 2 - frameBox.x - frameBox.width / 2) < 3);
  assert.equal(await history.locator('.agent-history-group').count(), 2);
  await history.getByText('第 2 轮', { exact: true }).first().waitFor();
  await history.locator('nav button').filter({ hasText: '开发 Agent' }).click();
  await history.locator('.agent-history-group').first().waitFor();
  assert.equal(await history.locator('.agent-history-group').count(), 1);
  await history.getByText('开发 Agent reply 0', { exact: true }).first().waitFor();
  await history.getByText('连续'.repeat(400), { exact: true }).first().waitFor();
  await history.locator('.agent-history-event').nth(213).waitFor();
  assert.equal(await history.locator('.agent-history-event').count(), 214, 'stream pages produce one continuous message per round');
  await page.screenshot({ path: '.test-results/work-flow/agent-history-single.png' });
  await history.getByRole('button', { name: '关闭', exact: true }).click();
  // Disable and enable through the public lifecycle API, preserving persisted workflow/run data.
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('work-flow', 'disable');
    await workDesk.plugins.disable('work-flow', preview.confirmationToken);
    await workDesk.plugins.enable('work-flow');
  });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await frame.locator(`[data-workflow="${flow.id}"]`).click();
  await frame.locator('#stage-wrap').click({ position: { x: 10, y: 350 } });
  assert.equal((await invoke('runs.list', flow.id)).length, 1, 'completed run survives plugin restart');
  await page.screenshot({ path: '.test-results/work-flow/agent-history-restart-panel.png' });
  await writeFile('.test-results/work-flow/agent-history-restart-panel.txt', await frame.locator('body').innerText());
  await frame.locator(`[data-history-run="${run.id}"]`).click();
  await history.locator('.agent-history-group').nth(1).waitFor();
  assert.match(await history.innerText(), /已归档/);
  await history.getByText('产品 Agent reply 0', { exact: true }).first().waitFor();
  await history.getByText('开发 Agent reply 0', { exact: true }).first().waitFor();
  await page.screenshot({ path: '.test-results/work-flow/agent-history-all-restored.png' });
  await history.getByRole('button', { name: '关闭', exact: true }).click();
  // The fixture holds every start until all four arrive, proving host calls overlap rather than run serially.
  const parallelFlow = await invoke('workflows.save', { name: '并行汇合与人工审核验证', nodes: [
    node('start', 'flow.start', {}),
    node('parallel', 'flow.parallel', { joinNodeId: 'join' }),
    ...['a', 'b', 'c', 'd'].map(id => node(id, 'agent.review', {
      input: id, providerId: 'coordination-provider'
    }, `并行审核 ${id}`)),
    node('join', 'flow.join', {}),
    node('approval', 'flow.user-input', { title: '本轮审核结论', interaction: 'choice',
      prompt: '四方已经汇合，请审核本轮结论。\n汇总：本轮需要修订，尚未达成一致。\n问题：["I-2：补充界面细节。统一像素尺寸和间距。","P0 I-1：补齐需求基线。请补充原文并核对验收标准。"]\n待确认：["Q-1：选择交付范围。请确认六种场地全部纳入本期。"]\n需求与设计对应关系：["场地加成：已覆盖六种场景。"]\n设计修改：["补充替补行动规则。"]', options: '确认本轮结论\n提出修改意见' }),
    node('done', 'flow.end', {})
  ], edges: [{ from: 'start', to: 'parallel' }, ...['a', 'b', 'c', 'd'].flatMap(id => [
    { from: 'parallel', to: id }, { from: id, to: 'join' }
  ]), { from: 'join', to: 'approval' }, { from: 'approval', to: 'done' }] });
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('work-flow', 'disable');
    await workDesk.plugins.disable('work-flow', preview.confirmationToken);
    await workDesk.plugins.enable('work-flow');
  });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await frame.locator(`[data-workflow="${parallelFlow.id}"]`).click();
  assert.ok((await invoke('agents.providers')).providers.some(provider => provider.pluginId === 'coordination-provider'));
  await frame.locator('#run').click();
  await popup.getByRole('button', { name: '允许并记住', exact: true }).click();
  await popup.getByRole('heading', { name: '本轮结论', exact: true }).waitFor();
  assert.equal(await popup.locator('details[open]').count(), 0, 'original review is collapsed');
  assert.deepEqual(await popup.locator('.plugin-message-section > h3').allTextContents(),
    ['本轮结论', '需要你确认', '阻断与高优先级问题', '其他问题', '覆盖与修订']);
  await page.screenshot({path:'.test-results/work-flow/review-cards-light.png'});
  await page.evaluate(async () => workDesk.storage.savePreferences({ ...(await workDesk.storage.getPreferences()), theme: 'dark' }));
  await page.reload();
  await popup.getByRole('heading', {name:'本轮结论',exact:true}).waitFor();
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.screenshot({path:'.test-results/work-flow/review-cards-dark.png'});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await page.waitForFunction(() => innerWidth <= 900);
  const reviewBox = await popup.boundingBox();
  const reviewViewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
  assert.ok(Math.abs(reviewBox.x + reviewBox.width / 2 - reviewViewport.width / 2) < 3);
  assert.ok(Math.abs(reviewBox.y + reviewBox.height / 2 - reviewViewport.height / 2) < 3);
  await page.screenshot({path:'.test-results/work-flow/review-cards-narrow.png'});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  const pendingRun = (await invoke('runs.list', parallelFlow.id)).at(-1);
  assert.equal(pendingRun.status, 'waiting');
  assert.equal(pendingRun.pending.nodeId, 'approval');
  assert.equal(Object.keys(pendingRun.nodes.join.output.results).length, 4);
  assert.equal((await calls()).filter(call => call.method === 'start' && call.name?.startsWith('并行审核')).length, 4);
  await popup.getByRole('button', { name: '确认本轮结论', exact: true }).click();
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  await frame.locator(`[data-workflow="${parallelFlow.id}"]`).click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  assert.equal((await invoke('runs.list', parallelFlow.id)).at(-1).status, 'succeeded');
  const openAgentFlow = async title => {
    const saved = await invoke('workflows.save', {name:title,nodes:[
      node('source','text.input',{content:'UI verification'}),
      node('agent','agent.review',{input:'{{source.text}}',providerId:'coordination-provider'},title)
    ],edges:[{from:'source',to:'agent'}]});
    await page.reload();
    await page.locator('.shelf-app[data-plugin="work-flow"]').click();
    await frame.locator(`[data-workflow="${saved.id}"]`).click();
    await frame.locator('#run').click();
    await popup.getByRole('button', {name:'允许并记住',exact:true}).click();
    return saved;
  };
  const nativeFlow = await openAgentFlow('授权 Agent');
  await popup.getByText('允许本次', {exact:true}).waitFor();
  const responsesBefore = (await calls()).filter(call => call.method === 'respond').length;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  assert.equal((await calls()).filter(call => call.method === 'respond').length, responsesBefore, 'never synthesize native approval');
  await popup.getByRole('button', {name:'允许本次',exact:true}).click();
  await frame.locator('#status-text').filter({hasText:'运行完成'}).waitFor();
  assert.equal((await invoke('runs.list', nativeFlow.id)).at(-1).status, 'succeeded');
  assert.equal((await calls()).filter(call => call.method === 'respond').at(-1).decision, 'accept');
  const liveFlow = await openAgentFlow('实时 Agent');
  await frame.locator(`[data-workflow="${liveFlow.id}"] [data-activity="agent"]`).waitFor();
  assert.doesNotMatch(await frame.locator('#status').innerText(), /Agent 任务处理中/);
  await frame.locator('#status').click();
  await history.getByText('连续'.repeat(400), {exact:true}).waitFor();
  const liveSession = (await invoke('runs.list', liveFlow.id)).at(-1).sessions[0].sessionId;
  const append = text => page.evaluate(({sessionId,text}) => workDesk.plugins.invoke('coordination-provider','probe.append',[
    {sessionId,text}]), {sessionId:liveSession,text});
  await append('最新内容');
  await history.getByText('连续'.repeat(400)+'最新内容', {exact:true}).waitFor();
  const transcript = history.locator('.agent-transcript');
  await transcript.evaluate(element => {element.scrollTop=0;});
  await append('继续输出');
  await history.getByText('连续'.repeat(400)+'最新内容继续输出', {exact:true}).waitFor();
  assert.equal(await transcript.evaluate(element => element.scrollTop), 0, 'reading old history keeps scroll position');
  await history.getByRole('button', {name:'关闭',exact:true}).click();
  const historyCalls = (await calls()).filter(call => call.method === 'history').length;
  await page.waitForTimeout(1300);
  assert.equal((await calls()).filter(call => call.method === 'history').length, historyCalls, 'closing history stops live polling');
  await frame.locator('#cancel-run').click();
  await frame.locator(`[data-workflow="${liveFlow.id}"] [data-activity]`).waitFor({state:'detached'});
  // A required prompt can still be revoked by the explicit workflow stop action.
  const requiredFlow = await openAgentFlow('必答 Agent');
  await popup.getByText('开发：确认像素尺寸', {exact:true}).waitFor();
  await frame.locator('#cancel-run').click();
  await popup.waitFor({state:'detached'});
  assert.deepEqual(errors, []);
});
