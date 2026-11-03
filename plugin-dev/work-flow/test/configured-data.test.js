import test from 'node:test';
import assert from 'node:assert/strict';
import { transformData, renderReport, mappedInput } from '../src/main/common/configured-data.js';

const rows=[{id:'9007199254740993',country:'AR',channel:'A',status:2,stock:1},{id:'2',country:'CO',channel:'A',status:1,stock:9},
  {id:'3',country:'CO',channel:'A',status:2,stock:2}];
test('one configured transformer handles order and inventory scenarios with typed values',()=>{
  assert.deepEqual(transformData(rows,{operations:[{op:'filter',field:'status',operator:'equals',value:2},
    {op:'select',fields:{order:'id',country:'country'}}]}),[{order:'9007199254740993',country:'AR'},{order:'3',country:'CO'}]);
  assert.deepEqual(transformData(rows,{operations:[{op:'filter',field:'stock',operator:'lt',value:3},
    {op:'sort',by:[{field:'stock',direction:'desc'}]},{op:'select',fields:{sku:'id'}}]}),[{sku:'3'},{sku:'9007199254740993'}]);
  assert.equal(rows.length,3);
});
test('batching never mixes countries and join/unique preserve string identifiers',()=>{
  const batches=transformData(rows,{operations:[{op:'batch',by:['country','channel'],size:1}]});
  assert.equal(batches.length,3);assert.ok(batches.every(b=>b.items.length===1&&b.items[0].country===b.key.country));
  const joined=transformData({left:rows,right:[{order:'9007199254740993',merchant:'M1'}]},
    {operations:[{op:'join',leftKey:'id',rightKey:'order',as:'payment',kind:'inner'}]});
  assert.equal(joined[0].payment.merchant,'M1');
  assert.equal(transformData([...rows,rows[0]],{operations:[{op:'unique',by:['id']}]}).length,3);
  assert.throws(()=>transformData(rows,{operations:[{op:'unknown'}]}),/不支持/);
});
test('mapping retains objects without interpolation injection and reports use configured groups/columns',()=>{
  const input=mappedInput('{"orders":"{{source.value}}","limit":6}',{source:{value:rows}});
  assert.deepEqual(input.orders,rows);assert.equal(input.limit,6);
  assert.throws(()=>mappedInput('{"rows":"{{missing.value}}"}',{}),/变量/);
  const report=renderReport(rows,{title:'测试巡检',groupBy:[{field:'channel',label:'渠道'},{field:'country',label:'国家'}],
    columns:[{field:'id',label:'申请单ID'},{field:'stock',label:'库存'}]});
  assert.match(report,/## 渠道：A/);assert.match(report,/### 国家：AR/);assert.match(report,/9007199254740993/);
  assert.doesNotMatch(report,/status/);
  assert.match(renderReport([{text:'<at id=all>|*'}],{columns:[{field:'text',label:'内容'}]}),/&lt;at id=all&gt;\\\|\\\*/);
});


test('join rejects excessive expansion before building the full result',()=>{
  const left=Array.from({length:300},()=>({id:'1'}));
  const right=Array.from({length:300},()=>({id:'1',text:'x'.repeat(512)}));
  assert.throws(()=>transformData({left,right},{operations:[{op:'join',leftKey:'id',rightKey:'id',as:'match'}]}),/上限/);
});
