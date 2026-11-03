import test from 'node:test';
import assert from 'node:assert/strict';
import { validWorkItemQuery } from '../src/shared/query-policy.js';
import { createCommands } from '../src/browser-extension/commands.js';

const valid = () => ({ pi: 0, ps: 100, criteria: { condition_logic: 1, conditions: [
  { property_key: 'completed_at', operation: 2, value: 0, logic: 1 },
  { property_key: 'completed_at', operation: 5, value: 1, logic: 1 }
] } });
test('only bounded date queries can use the work-item POST route', async () => {
  assert.equal(validWorkItemQuery(valid()), true);
  for (const body of [{ title: 'create' }, { ...valid(), title: 'create' }, { ...valid(), ps: 1000 },
    { ...valid(), criteria: { conditions: [], condition_logic: 1 } }]) {
    assert.equal(validWorkItemQuery(body), false);
  }
  const commands = createCommands({});
  await assert.rejects(commands.execute({ id: 'one', site: 'https://example.pingcode.com', action: 'query',
    path: '/api/agile/work-items/one/title', params: valid() }));
  await assert.rejects(commands.execute({ id: 'two', site: 'https://example.pingcode.com', action: 'query',
    path: '/api/agile/work-items', params: { title: 'write' } }));
});
