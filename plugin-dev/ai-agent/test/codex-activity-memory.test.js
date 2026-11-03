import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCodexActivity } from '../src/main/common/adapters/codex-activity.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('idle native logs are parsed once until their content or file identity changes', async t => {
  const storage = await temporaryStore(t);
  const directory = join(storage.root, 'profiles/default/codex/sessions');
  await mkdir(directory, { recursive: true });
  const session = { id: 'memory-fixture', pluginId: 'test', contextId: 'first-thread', activity: 'working', sequence: 0 };
  const path = join(directory, 'rollout-first-thread.jsonl');
  const completed = 'memory-fixture: completed';
  const event = text => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: text } }) + '\n';
  await writeFile(path, event(completed));
  let parses = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (...args) => {
    if (args[0].includes('memory-fixture:')) {
      parses++;
    }
    return parse(...args);
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const monitor = prepareCodexActivity(state => Object.assign(session, state), session, storage.root);
  t.after(() => monitor.close());
  const tick = async () => {
    t.mock.timers.tick(750);
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  await tick();
  assert.equal(session.activity, 'done');
  assert.equal(parses, 1);
  for (let index = 0; index < 3; index++) {
    await tick();
  }
  assert.equal(parses, 1, 'unchanged idle logs must not allocate and parse their tail on every poll');
  session.activity = 'working';
  await tick();
  assert.equal(session.activity, 'done', 'cached completion still reconciles background terminal redraws');

  await appendFile(path, event('memory-fixture: 请确认目标环境。'));
  await tick();
  assert.equal(session.blocked, 'question');
  assert.equal(parses, 2);
  session.blocked = null;
  await writeFile(`${path}.replacement`, event(completed));
  await rename(`${path}.replacement`, path);
  await tick();
  assert.equal(session.blocked, null, 'replacement files invalidate the previous question');
  assert.equal(parses, 3);

  session.contextId = 'second-thread';
  await writeFile(join(directory, 'rollout-second-thread.jsonl'), event('memory-fixture: 请选择方案。'));
  await tick();
  assert.equal(session.blocked, 'question');
  assert.equal(parses, 4, 'another native context must never reuse the previous file cache');
});
