import test from 'node:test';
import assert from 'node:assert/strict';
import { WebClient } from '../src/main/common/web-client.js';

test('web task rows resolve references, filter by actual assignee and retain own value score', async () => {
  const calls = [];
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async (site, path, params) => {
      calls.push({ site, path, params });
      return { value: [{ _id: 'a', short_id: 'abc', whole_identifier: 'DKY-1', title: 'sample',
        project_id: 'project', assignee: 'person', state_id: 'state', created_at: 1790000000, completed_at: null,
        properties: { renwujiazhifen: 5, story_points: 99 } }],
      count: 1, page_index: 0, references: { projects: [{ _id: 'project', name: '项目' }], members: [{ uid: 'person', display_name: '吴杰' }],
        states: [{ _id: 'state', name: '进行中' }] } };
    }
  });
  const rows = await client.tasks({ assigneeId: 'person', projectId: 'project' });
  assert.equal(rows[0].score, 5);
  assert.equal(rows[0].assignee, '吴杰');
  assert.equal(rows[0].state, '进行中');
  assert.equal(rows[0].createdAt, 1790000000);
  assert.equal(rows[0].completedAt, null);
  assert.equal(rows[0].url, 'https://example.pingcode.com/pjm/workitems/abc');
  assert.equal(calls[0].site, 'https://example.pingcode.com');
});

test('web members keep same-name people distinct and pagination rejects incomplete data', async () => {
  let page = 0;
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async () => ({ value: [{ _id: String(page), name: '项目' }], page_index: page,
      references: { members: [{ uid: String(page++), display_name: '吴杰' }] }, count: 2 })
  });
  assert.equal((await client.members('吴杰')).length, 2);
  const incomplete = new WebClient({ site: 'https://example.pingcode.com' }, { read: async () => ({ value: [], count: 4, page_index: 0 }) });
  await assert.rejects(incomplete.projects(), /分页/);
});

test('role selection matches the custom member field even when detail loading is required', async () => {
  const refs = { members: [{ uid: 'person', display_name: '吴杰' }, { uid: 'other', display_name: '其他人' }] };
  const values = [
    { _id: 'owner', assignee: 'person', properties: { kaifafuzeren: 'other', ceshifuzeren: null } },
    { _id: 'developer', assignee: 'other', properties: { kaifafuzeren: 'person', ceshifuzeren: 'other' } },
    { _id: 'tester', assignee: 'other', properties: { kaifafuzeren: 'other', ceshifuzeren: 'person' } }
  ].map(row => ({ ...row, project_id: 'p', created_at: 1790000000, completed_at: null,
    properties: { ...row.properties, renwujiazhifen: 5 } }));
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async (_site, path) => path === '/api/agile/work-items'
      ? { value: values.map(({ properties, ...row }) => ({ ...row, properties: { renwujiazhifen: 5 } })),
        count: values.length, page_index: 0, references: refs }
      : { value: values.find(row => path.endsWith('/' + row._id)), references: refs }
  });
  for (const [role, expected] of [['assignee', 'owner'], ['developer', 'developer'], ['tester', 'tester']]) {
    const rows = await client.tasks({ assigneeId: 'person', projectId: 'p', role });
    assert.deepEqual(rows.map(row => row.id), [expected]);
    assert.equal(rows[0].assignee, '吴杰');
  }
  await assert.rejects(client.tasks({ assigneeId: 'person', role: 'unknown' }), /角色/);
});
