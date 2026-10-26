// Explicit smoke test: uses the authenticated Codex CLI against a temporary HTTP MCP endpoint.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, owner } from '../../../desk/test/electron/helpers.js';
import { remoteFixture } from './remote-fixture.mjs';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') { delete process.env[key]; }
}
const cleanup=[];
const report={cases:[]};
const remote=await remoteFixture();
cleanup.push(()=>remote.close());
const directory=resolve('.test-results/mcp-remote');
await mkdir(directory,{recursive:true});
try {
  const {app,page,data}=await launch({after:fn=>cleanup.push(fn)},{openPlugin:false});
  if (process.env.WORK_DESK_MCP_PACKAGE) {
    await page.evaluate(async()=>{
      const preview=await workDesk.plugins.preview('mcp-services','remove');
      await workDesk.plugins.remove('mcp-services','keep',preview.confirmationToken);
    });
    await app.evaluate(({dialog},source)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});
    },resolve(process.env.WORK_DESK_MCP_PACKAGE));
    await page.evaluate(()=>workDesk.plugins.install());
  }
  await page.evaluate(async ({url,apiKey})=>{
    await workDesk.plugins.invoke('mcp-services','mcp.save',[{id:'remote',name:'Remote smoke',transport:'http',url,apiKey}]);
    await workDesk.plugins.invoke('mcp-services','mcp.start',['remote']);
  },{url:remote.url,apiKey:remote.secret});
  const cwd=join(data,'MCP smoke workspace');
  await mkdir(cwd);
  const prompt=marker=>`Call the available verification_echo MCP tool with text "${marker}". You must actually call the MCP tool, then reply with its result. Do not call shell or other tools.`;
  const base=['--no-daemon','--no-alt-screen','-c',`projects.${JSON.stringify(cwd)}.trust_level="trusted"`];
  async function configure(initial) {
    await page.evaluate(({owner,args})=>workDesk.plugins.invoke(owner,'storage.saveAdapterConfig',[{codex:{command:'codex',args}}]),
      {owner,args:[...base,...(initial?[prompt(initial)]:[])]});
  }
  async function observe(session,marker) {
    const deadline=Date.now()+90000;
    let snapshot;
    while (Date.now()<deadline) {
      snapshot=await page.evaluate(({owner,id})=>workDesk.plugins.invoke(owner,'sessions.attach',[id]),{owner,id:session.id});
      if (remote.calls.some(value=>value.arguments.text===marker)) {
        report.cases.push({mode:marker,toolCalled:true});
        console.log(`${marker}: real MCP tool call observed`);
        await writeFile(join(directory,`${marker}.txt`),snapshot.data);
        // Let the tool result reach the model before archiving its context.
        await delay(3000);
        return;
      }
      await delay(500);
    }
    await writeFile(join(directory,`${marker}.txt`),snapshot?.data||'');
    throw Error(`No MCP call observed for ${marker}`);
  }
  async function submit(session,marker) {
    await page.evaluate(({owner,id,text})=>workDesk.plugins.invoke(owner,'sessions.write',[id,text]),{owner,id:session.id,text:prompt(marker)});
    await delay(250);
    await page.evaluate(({owner,id})=>workDesk.plugins.invoke(owner,'sessions.write',[id,'\r']),{owner,id:session.id});
  }
  await configure('MCP_NEW');
  const first=await page.evaluate(({owner,cwd})=>workDesk.plugins.invoke(owner,'sessions.create',[
    {adapterId:'codex',name:'MCP real smoke',cwd,permission:'unrestricted'}]),{owner,cwd});
  await observe(first,'MCP_NEW');
  const archive=await page.evaluate(({owner,id})=>workDesk.plugins.invoke(owner,'sessions.archive',[id]),{owner,id:first.id});
  assert.ok(archive.contextId);
  report.contextId=archive.contextId;
  await configure();
  const resumed=await page.evaluate(({owner,id})=>workDesk.plugins.invoke(owner,'sessions.restore',[id]),{owner,id:archive.id});
  await delay(4000);
  await submit(resumed,'MCP_RESUME');
  await observe(resumed,'MCP_RESUME');
  const fork=await page.evaluate(({owner,id})=>workDesk.plugins.invoke(owner,'sessions.fork',[id,'MCP fork']),{owner,id:resumed.id});
  await delay(4000);
  await submit(fork,'MCP_FORK');
  await observe(fork,'MCP_FORK');
  const forkArchive=await page.evaluate(({owner,id})=>workDesk.plugins.invoke(owner,'sessions.archive',[id]),{owner,id:fork.id});
  assert.ok(forkArchive.contextId);
  assert.notEqual(forkArchive.contextId,archive.contextId);
  report.forkContextId=forkArchive.contextId;
  report.passed=true;
} catch(error) {
  report.error={message:error.message};
  process.exitCode=1;
} finally {
  for(const fn of cleanup.reverse()) { await fn(); }
  await writeFile(join(directory,'codex-real.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
