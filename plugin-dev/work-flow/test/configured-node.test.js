import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from '../src/main/common/nodes.js';

function context(params) {
  return {params,variables:{source:{value:[{id:'1',status:2}]}},shouldStop:()=>false,runId:'fixture-run',nodeId:'custom'};
}
test('one stable node type supports configuration, JS and Python without source interpolation',async()=>{
  const node=createRegistry({credentials:{},logger:()=>{}}).get('custom.configured');
  assert.equal(node.params.find(field=>field.name==='code').templated,false);
  for(const language of ['javascript','python']) {
    const output=await node.resolve(context({mode:'script',language,inputMapping:'{"rows":"{{source.value}}"}',
      config:'{"label":"literal"}',code:language==='javascript'?'return {literal:"{{source.value}}",count:input.rows.length};':'return {"literal":"{{source.value}}","count":len(input["rows"])}',
      pythonExecutable:'/usr/bin/python3',timeoutSeconds:5}));
    assert.deepEqual(output.value,{literal:'{{source.value}}',count:1});
  }
  const output=await node.resolve(context({mode:'transform',input:[{id:'1',status:2},{id:'2',status:1}],config:'{"operations":[{"op":"filter","field":"status","value":2}]}',timeoutSeconds:5}));
  assert.equal(output.value.length,1);
});
test('report configuration saves MD to an explicit directory and returns a reusable path',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'configured-report-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const node=createRegistry({credentials:{},logger:()=>{}}).get('custom.configured');
  const output=await node.resolve(context({mode:'report',input:[{id:'123',merchant:'M1'}],
    config:JSON.stringify({directory,title:'测试报告',columns:[{field:'id',label:'申请单ID'},{field:'merchant',label:'渠道订单号'}]}),timeoutSeconds:5}));
  assert.match(output.path,/\.md$/);assert.match(await readFile(output.path,'utf8'),/渠道订单号/);
});
