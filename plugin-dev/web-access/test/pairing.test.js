import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Pairing } from '../src/main/common/pairing.js';

const proof=(invite,peer,nonce)=>createHmac('sha256',Buffer.from(invite.secret,'hex'))
  .update(`work-desk/web-access/1\nhost\n${peer}\n${invite.pairId}\n${nonce}`).digest('hex');

test('pairing binds both endpoints and challenge, consumes atomically and requires native confirmation',async()=>{
  const saved=[];
  let now=1000;
  const pairs=new Pairing({hostId:'host',devices:[],now:()=>now,persist:async value=>saved.push(value)});
  const invite=pairs.create('ticket');
  assert.throws(()=>pairs.request({pairId:invite.pairId,label:'Phone',proof:proof(invite,'other','nonce')},'phone','nonce'));
  const pending=pairs.request({pairId:invite.pairId,label:'Phone',proof:proof(invite,'phone','nonce')},'phone','nonce');
  assert.equal(pairs.approved('phone'),false);
  const confirmations=await Promise.allSettled([pairs.confirm(pending.requestId),pairs.confirm(pending.requestId)]);
  assert.equal(confirmations.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(pairs.approved('phone'),true);
  assert.equal(saved.length,1);
  assert.throws(()=>pairs.request({pairId:invite.pairId,label:'Phone',proof:proof(invite,'phone','nonce')},'phone','nonce'));
  const expired=pairs.create('ticket');
  now+=120001;
  assert.throws(()=>pairs.request({pairId:expired.pairId,label:'Phone',proof:proof(expired,'phone','nonce')},'phone','nonce'));
});

test('device revocation blocks memory immediately and persistence failure stops publication',async()=>{
  let stopped=0;
  let disconnected='';
  const pairs=new Pairing({hostId:'host',devices:[{deviceId:'phone'}],persist:async()=>{throw Error('disk full');},
    failClosed:async()=>{stopped++;},disconnect:async id=>{disconnected=id;}});
  await assert.rejects(pairs.revoke('phone'),/disk full/);
  assert.equal(pairs.approved('phone'),false);
  assert.equal(disconnected,'phone');
  assert.equal(stopped,1);
});

test('failed disconnect also stops publication during device revocation', async () => {
  let stopped = false;
  const pairs = new Pairing({ hostId: 'host', devices: [{ deviceId: 'phone' }], persist: async () => {},
    failClosed: async () => { stopped = true; }, disconnect: async () => { throw Error('broker unavailable'); } });
  await assert.rejects(pairs.revoke('phone'), /broker unavailable/);
  assert.equal(stopped, true);
});
