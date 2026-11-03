import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHello, validateService, readFrame, writeFrame, StreamBudget } from '../src/main/common/protocol.js';

test('protocol rejects target injection, unknown versions and oversized control frames',async()=>{
  assert.throws(()=>validateHello({type:'hello',version:2}));
  assert.throws(()=>validateHello({type:'hello',version:1,target:'localhost:22'}));
  assert.throws(()=>validateService({type:'stream',serviceId:'workspace',port:22},['workspace']));
  assert.throws(()=>validateService({type:'stream',serviceId:'plugin:unknown'},['workspace']));
  assert.equal(validateService({type:'stream',serviceId:'workspace'},['workspace']),'workspace');
  await assert.rejects(readFrame({readExact:async()=>[0,1,0,1]}));
  const bytes=[];
  await writeFrame({writeAll:async part=>bytes.push(...part)},{type:'hello',version:1});
  let offset=0;
  assert.deepEqual(await readFrame({readExact:async n=>bytes.slice(offset,(offset+=n))}),{type:'hello',version:1});
});

test('stream budget is per authenticated device and releases after disconnect',()=>{
  const budget=new StreamBudget({perDevice:2,total:3});
  const a=budget.acquire('a');
  const b=budget.acquire('a');
  assert.throws(()=>budget.acquire('a'));
  const c=budget.acquire('b');
  assert.throws(()=>budget.acquire('c'));
  a();a();
  const d=budget.acquire('a');
  b();c();d();
  assert.equal(budget.count,0);
});
