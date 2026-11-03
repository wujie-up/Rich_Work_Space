import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { Workflows } from '../src/main/common/workflows.js';
import { WorkflowTransfer } from '../src/main/common/workflow-transfer.js';
import { Runs } from '../src/main/common/runs.js';
import { Engine } from '../src/main/common/engine.js';
import { createRegistry } from '../src/main/common/nodes.js';

for (const name of ['orders-script','inventory-config']) {
  test(`independent ${name} workflow imports and executes with only the shared custom type`, async t => {
    const root=await mkdtemp(join(tmpdir(),'configured-workflow-'));
    const registry=createRegistry({credentials:{},logger:()=>{}});
    const storage=new Storage(root);
    const workflows=new Workflows({storage,pluginId:'work-flow',classify:id=>registry.get(id)});
    const runs=new Runs({storage,pluginId:'work-flow'});
    const engine=new Engine({registry,runs,credentials:{},agents:{release:async()=>[]},emit:()=>{},logger:()=>{},pluginId:'work-flow'});
    t.after(async()=>{await engine.stop('fixture');await runs.list(workflow.id);await rm(root,{recursive:true,force:true,maxRetries:3});});
    const transfer=new WorkflowTransfer({workflows,types:()=>registry.list(),activeRun:()=>false,logger:()=>{}});
    const document=JSON.parse(await readFile(new URL(`../../../docs/workflows/configured-node/${name}.workflow.json`,import.meta.url),'utf8'));
    const {workflow}=await transfer.import({document});
    assert.equal(workflow.trigger.mode,'manual');
    const started=await engine.start(workflow);
    let run;
    for(let i=0;i<300;i++) {
      run=engine.get(started.id);
      if(run.status!=='running') break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(run.status,'succeeded',JSON.stringify(run.error));
    assert.equal((await workflows.list()).length,1);
    const report=run.nodes.report.output.value;
    if(name==='orders-script') {
      assert.match(run.nodes.js.output.stdout,/literal: \{\{source.value\}\}/);
      assert.equal(run.nodes.js.output.value.length,2);assert.equal(run.nodes.python.output.value.length,2);
      assert.match(report,/9007199254740993/);assert.match(report,/渠道订单号/);assert.doesNotMatch(report,/fixture-M3/);
    } else {
      assert.equal(run.nodes.filter.output.value.length,2);assert.match(report,/SKU-A/);assert.doesNotMatch(report,/SKU-B/);
    }
    const exported=transfer.definition(workflow).workflow;
    assert.equal(exported.nodes.find(n=>n.id==='report').params.config,workflow.nodes.find(n=>n.id==='report').params.config);
    assert.ok(workflow.nodes.every(n=>['flow.start','text.input','custom.configured','flow.end'].includes(n.type)));
  });
}

test('a looping script can be canceled while an independent configured workflow still completes', async t => {
  const {createScriptRunner}=await import('../src/main/common/scripts.js');
  const root=await mkdtemp(join(tmpdir(),'configured-isolation-'));
  const snapshots=[];
  const scripts=createScriptRunner({ownProcesses:pids=>snapshots.push([...pids])});
  const registry=createRegistry({credentials:{},scripts,logger:()=>{}});
  const storage=new Storage(root);
  const workflows=new Workflows({storage,pluginId:'work-flow',classify:id=>registry.get(id)});
  const runs=new Runs({storage,pluginId:'work-flow'});
  const engine=new Engine({registry,runs,credentials:{},agents:{release:async()=>[]},emit:()=>{},logger:()=>{},pluginId:'work-flow'});
  t.after(async()=>{scripts.stop();await engine.stop('fixture');await rm(root,{recursive:true,force:true,maxRetries:3});});
  const slow=await workflows.save({name:'[测试] 可取消脚本',trigger:{mode:'manual'},nodes:[
    {id:'start',type:'flow.start',title:'开始',params:{}},
    {id:'script',type:'custom.configured',title:'独立进程循环',params:{mode:'script',language:'javascript',code:'while(true){}',config:'{}',timeoutSeconds:10}},
    {id:'end',type:'flow.end',title:'结束',params:{}}],edges:[{from:'start',to:'script'},{from:'script',to:'end'}]});
  const fastDefinition=JSON.parse(await readFile(new URL('../../../docs/workflows/configured-node/inventory-config.workflow.json',import.meta.url),'utf8')).workflow;
  const fast=await workflows.save(fastDefinition);
  const slowRun=await engine.start(slow);
  for(let i=0;i<100&&!snapshots.some(pids=>pids.length);i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(snapshots.some(pids=>pids.length));
  const fastRun=await engine.start(fast);
  for(let i=0;i<100&&engine.get(fastRun.id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(engine.get(fastRun.id).status,'succeeded');
  await engine.cancel(slowRun.id);
  for(let i=0;i<100&&engine.get(slowRun.id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(engine.get(slowRun.id).status,'canceled');
  assert.deepEqual(snapshots.at(-1),[]);
  assert.equal(engine.get(fastRun.id).status,'succeeded');
});
