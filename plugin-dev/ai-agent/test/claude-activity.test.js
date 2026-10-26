import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareClaudeActivity } from '../src/main/common/adapters/claude-activity.js';

test('native Claude hooks update the bound context and state without approving any operation', async t => {
  const states = [];
  const monitor = await prepareClaudeActivity(state => states.push(state));
  t.after(() => monitor.close());
  const hook = monitor.settings.hooks.PermissionRequest[0].hooks[0];
  for (const event of [
    { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PermissionRequest' },
    { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, { hook_event_name: 'PostToolUse' },
    { hook_event_name: 'Stop' }
  ]) {
    const response = await fetch(hook.url, { method: 'POST', body: JSON.stringify({ ...event, session_id: 'native-context' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
  }
  assert.deepEqual(states.map(state => [state.activity, state.blocked]), [
    ['working', null], ['idle', 'permission'], ['idle', 'question'], ['working', null], ['done', null]
  ]);
  assert.ok(states.every(state => state.contextId === 'native-context'));
  const wrong = new URL(hook.url);
  wrong.pathname = '/other-session';
  assert.equal((await fetch(wrong, { method: 'POST', body: '{}' })).status, 404);
  assert.equal(states.length, 5);
});
