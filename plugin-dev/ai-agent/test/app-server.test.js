import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { AppServer } from '../src/main/common/app-server.js';

test('app-server frames partial JSON, correlates requests, streams events, and answers approvals without logging credentials', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  const sent = [];
  child.stdin = new Writable({ write(chunk, _, done) { sent.push(JSON.parse(chunk)); done(); } });
  const events = [];
  let owned;
  child.pid = 8001;
  const server = new AppServer({ spawn: () => child, onEvent: message => events.push(message),
    onSpawn: () => { owned = server.child.pid; } });
  const ready = server.start({ command: '/managed/codex', env: {}, args: [] });
  assert.equal(owned, 8001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].method, 'initialize');
  child.stdout.write('{"id":1,"res');
  child.stdout.write('ult":{"userAgent":"native"}}\n');
  await ready;
  assert.equal(sent[1].method, 'initialized');
  const account = server.request('account/read', {});
  child.stdout.write(JSON.stringify({ id: sent.at(-1).id, result: { account: null } }) + '\n');
  assert.equal((await account).account, null);
  child.stdout.write('{"id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"t","turnId":"u","command":"ls"}}\n');
  assert.equal(events.at(-1).id, 99);
  server.respond(99, { decision: 'decline' });
  assert.deepEqual(sent.at(-1), { id: 99, result: { decision: 'decline' } });
  const pending = server.request('thread/read', {});
  child.emit('exit', 1);
  await assert.rejects(pending, /退出/);
});
