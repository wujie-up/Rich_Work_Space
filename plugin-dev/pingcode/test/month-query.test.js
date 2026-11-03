import test from 'node:test';
import assert from 'node:assert/strict';
import { WebClient } from '../src/main/common/web-client.js';

const config = { site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' };
const start = new Date(2026, 9, 1).getTime() / 1000;
const end = new Date(2026, 10, 1).getTime() / 1000;

test('monthly work items use the native filtered query and read details only from its month scope', async () => {
  const calls = [];
  const client = new WebClient(config, {
    query: async (_site, body) => {
      calls.push({ kind: 'query', body });
      return { value: [{ _id: 'october', project_id: 'p', assignee: 'person', created_at: start,
        completed_at: start + 1, properties: {} }], count: 1, page_index: 0, page_size: 100 };
    },
    read: async (_site, path) => {
      calls.push({ kind: 'detail', path });
      assert.equal(path, '/api/agile/work-items/october');
      return { value: { _id: 'october', assignee: 'person', project_id: 'p', created_at: start,
        completed_at: start + 1, properties: { renwujiazhifen: 5 } } };
    }
  });
  const rows = await client.tasks({ assigneeId: 'person', projectId: 'p', month: '2026-10', dateField: 'completedAt' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 5);
  const query = calls[0].body;
  assert.equal(query.project_id, 'p');
  assert.deepEqual(query.criteria.conditions.slice(0, 2).map(({ property_key, operation, value }) => ({ property_key, operation, value })), [
    { property_key: 'completed_at', operation: 2, value: start }, { property_key: 'completed_at', operation: 5, value: end }
  ]);
  assert.equal(calls.filter(call => call.kind === 'detail').length, 1);
});

test('an ignored month filter fails before any historical detail can be fetched', async () => {
  let details = 0;
  const client = new WebClient(config, {
    query: async () => ({ value: [{ _id: 'old', assignee: 'person', project_id: 'p', created_at: start - 1,
      completed_at: start - 1, properties: {} }], count: 1, page_index: 0, page_size: 100 }),
    read: async () => { details++; throw Error('Historical detail must not be fetched'); }
  });
  await assert.rejects(client.tasks({ assigneeId: 'person', projectId: 'p', month: '2026-10' }), /月份/);
  assert.equal(details, 0);
});
