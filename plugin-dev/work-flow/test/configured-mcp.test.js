import test from 'node:test';
import assert from 'node:assert/strict';
import { callConfiguredMcp, bindSql } from '../src/main/common/configured-mcp.js';

function tasksFor(pages, state='granted') {
  const calls=[];const revoked=[];
  const providers=[['call',['mcp.tool']],['describe',['network.read']]].map(([id,effects])=>({state:'ready',handle:{pluginId:'mcp',capabilityId:id},descriptor:{id,effects,source:{serviceId:'fixture'}}}));
  return {calls,revoked,capabilities:{discover:async()=>({providers}),authorize:async()=>({id:'lease'}),authorization:async()=>({state}),revoke:async id=>revoked.push(id)},
    async call(id,input){if(id==='describe')return {tools:[{name:'query'}]};calls.push(input);const data=pages.shift();return {content:[{type:'text',text:JSON.stringify(data)}]};}};
}
const config={serviceId:'fixture',tool:'query',arguments:{database:'fixture',sql:'SELECT id FROM fixture WHERE id > {{cursor}} AND country={{country}}'},
  bindings:{country:{type:'string',value:'{{input.country}}'}},resultPath:'rows',pagination:{cursorField:'id',pageSize:2,maxPages:10,initial:'0'}};
const context={runId:'run',nodeId:'node',variables:{},shouldStop:()=>false,timeoutSeconds:5};
test('typed SQL bindings preserve large IDs and quote text without concatenation',()=>{
  assert.equal(bindSql('id={{id}} AND name={{name}}',{id:{type:'integer',value:'9007199254740993'},name:{type:'string',value:"O'Reilly"}}),"id=9007199254740993 AND name='O''Reilly'");
  assert.throws(()=>bindSql('id={{id}}',{id:{type:'integer',value:'1 OR 1=1'}}));
  assert.throws(()=>bindSql('id={{missing}}',{}));
});
test('serial foreach pagination returns every row, resets cursor per country and revokes authorization',async()=>{
  const tasks=tasksFor([{status:'ok',rows:[{id:'1'},{id:'2'}],truncated:true},{status:'ok',rows:[],truncated:false},
    {status:'ok',rows:[{id:'3'}],truncated:false}]);
  const output=await callConfiguredMcp(tasks,{...config,forEach:true},[{country:'AR'},{country:'CO'}],context);
  assert.deepEqual(output.value,[{id:'1'},{id:'2'},{id:'3'}]);assert.equal(output.pages,3);
  assert.match(tasks.calls[0].arguments.sql,/id > 0 AND country='AR'/);
  assert.match(tasks.calls[2].arguments.sql,/id > 0 AND country='CO'/);
  assert.deepEqual(tasks.revoked,['lease']);
});
test('denied, unknown tool, stuck cursor and truncated empty page cannot become empty success',async()=>{
  const denied=tasksFor([],'denied');await assert.rejects(callConfiguredMcp(denied,config,{country:'AR'},context));assert.equal(denied.calls.length,0);
  const stuck=tasksFor([{status:'ok',rows:[{id:'1'},{id:'2'}],truncated:true},{status:'ok',rows:[{id:'2'}],truncated:false}]);
  await assert.rejects(callConfiguredMcp(stuck,config,{country:'AR'},context),/游标/);assert.deepEqual(stuck.revoked,['lease']);
  await assert.rejects(callConfiguredMcp(tasksFor([{status:'ok',rows:[],truncated:true}]),config,{country:'AR'},context),/截断/);
});


test('non-paginated truncated data and SQL placeholders inside quotes are rejected', async () => {
  const {pagination,...single}=config;
  single.arguments={sql:'SELECT id FROM fixture'};
  await assert.rejects(callConfiguredMcp(tasksFor([{status:'ok',rows:[{id:'1'}],truncated:true}]),single,{country:'AR'},context),/截断/);
  assert.throws(()=>bindSql("SELECT id WHERE name='{{name}}'",{name:{type:'string',value:"' OR 1=1 -- "}}),/引号/);
});

test('SQL comments and alternate quoted literals cannot desynchronize placeholder quoting',()=>{
  const bindings={name:{type:'string',value:"' OR 1=1 -- "}};
  assert.throws(()=>bindSql("-- user's query\nSELECT id WHERE name='{{name}}'",bindings),/注释/);
  assert.throws(()=>bindSql('SELECT $$quoted {{name}}$$',bindings),/引用/);
  assert.throws(()=>bindSql('SELECT [{{name}}] FROM fixture',bindings),/引号/);
});
