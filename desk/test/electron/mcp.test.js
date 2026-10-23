import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { launch, openWorkspace } from './helpers.js';
import { remoteFixture } from '../../../plugins/plugins/mcp/test/remote-fixture.mjs';

await mkdir('.test-results/mcp-remote', {recursive:true});
test('remote MCP UI enables address/key, AI discovers and calls without selection, reload preserves data', {timeout:90000}, async t => {
  const remote = await remoteFixture();
  t.after(()=>remote.close());
  const {app,page,data}=await launch(t,{openPlugin:false, executablePath:process.env.WORK_DESK_TEST_EXECUTABLE});
  async function installArchive() {
    await page.evaluate(async () => {
      const preview=await workDesk.plugins.preview('mcp-services','remove');
      await workDesk.plugins.remove('mcp-services','keep',preview.confirmationToken);
    });
    await app.evaluate(({dialog},source)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});
    },resolve(process.env.WORK_DESK_MCP_PACKAGE));
    await page.evaluate(()=>workDesk.plugins.install());
  }
  if (process.env.WORK_DESK_MCP_PACKAGE) { await installArchive(); }
  await openWorkspace(page, 'mcp-services');
  const frame=page.frameLocator('iframe[title="MCP 服务"]');
  await frame.locator('h1').waitFor();
  assert.equal(await frame.locator('[name="transport"]').inputValue(),'http');
  await frame.locator('[name="name"]').fill('远程 MCP 验证');
  await frame.locator('[name="url"]').fill(remote.url);
  await frame.locator('[name="apiKey"]').fill(remote.secret);
  assert.equal(await frame.locator('[name="apiKey"]').getAttribute('type'),'password');
  await frame.getByRole('button',{name:'保存并启用',exact:true}).click();
  await frame.locator('#services').getByText(/running/).waitFor();
  assert.equal(await frame.locator('#choices input:checked:disabled').count(),1);
  assert.equal(await frame.locator('#save-ai').isVisible(),false);
  await frame.getByRole('button',{name:'发现工具',exact:true}).click();
  await frame.locator('#tool option[value="verification_echo"]').waitFor({state:'attached'});
  await frame.locator('#arguments').fill('{"text":"UI-REAL-CALL"}');
  await frame.getByRole('button',{name:'试调用',exact:true}).click();
  await frame.locator('#result').getByText(/REMOTE:UI-REAL-CALL/).waitFor();
  assert.deepEqual(await page.evaluate(()=>workDesk.plugins.invoke('mcp-services','mcp.ai.list').then(value=>value.selected)),[]);
  // Consume the resolved gateway configuration with a real SDK client, without manual service selection.
  const overrides=await page.evaluate(async()=>{
    const result = await workDesk.plugins.invoke('mcp-services','mcp.ai.launch',[{clientId:'codex'}]);
    return result.overrides;
  });
  assert.equal(overrides.length,2);
  assert.ok(!overrides.join('').includes(remote.secret));
  const url=JSON.parse(overrides[0].slice(overrides[0].indexOf('=')+1));
  const authorization=JSON.parse(overrides[1].match(/Authorization = (".*") }$/)[1]);
  const client=new Client({name:'ai-consumer-verification',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:authorization}}});
  await client.connect(transport);
  assert.equal((await client.listTools()).tools[0].name,'verification_echo');
  assert.equal((await client.callTool({name:'verification_echo',arguments:{text:'AI-AUTO-DISCOVERY'}})).content[0].text,'REMOTE:AI-AUTO-DISCOVERY');
  await transport.terminateSession();
  await client.close();
  await page.screenshot({path:'.test-results/mcp-remote/remote-enabled.png'});
  const servicePath=join(data,'plugin-data/mcp-services/services.json');
  const before=await readFile(servicePath,'utf8');
  await page.reload();
  assert.equal(await readFile(servicePath,'utf8'),before);
  await openWorkspace(page,'mcp-services');
  await frame.getByRole('button',{name:'停用服务',exact:true}).click();
  await frame.locator('#services').getByText(/stopped/).waitFor();
  assert.deepEqual(await page.evaluate(()=>workDesk.plugins.invoke('mcp-services','mcp.ai.launch',[{clientId:'codex'}])),{version:1,overrides:[]});
  await frame.locator('[name="apiKey"]').fill('incorrect-test-key');
  await frame.getByRole('button',{name:'保存并启用',exact:true}).click();
  await frame.locator('#status').getByText(/启动失败/).waitFor();
  await frame.locator('#services').getByText(/error/).waitFor({timeout:3000});
  await frame.locator('[name="apiKey"]').fill(remote.secret);
  await frame.getByRole('button',{name:'保存配置',exact:true}).click();
  await frame.locator('#status').getByText('已完成',{exact:true}).waitFor();
  const id=await frame.locator('[name="id"]').inputValue();
  const logs=await page.evaluate(id=>workDesk.plugins.invoke('mcp-services','mcp.logs',[id]),id);
  assert.ok(!logs.includes(remote.secret));
  assert.ok(!logs.includes('incorrect-test-key'));
  const marker=join(data,'plugin-data/mcp-services/history-marker.json');
  await writeFile(marker,'{"retained":true}');
  if (process.env.WORK_DESK_MCP_PACKAGE) {
    const saved=await readFile(servicePath,'utf8');
    await installArchive();
    assert.equal(await readFile(servicePath,'utf8'),saved);
    assert.equal(await readFile(marker,'utf8'),'{"retained":true}');
  }
  assert.equal(remote.calls.length,2);
});
