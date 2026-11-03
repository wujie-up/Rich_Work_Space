import test from 'node:test';
import assert from 'node:assert/strict';
import { WebClient } from '../src/main/common/web-client.js';

const rows = Array.from({ length: 8 }, (_, index) => ({ _id: String(index), assignee: 'person', project_id: 'p',
  created_at: 1790000000, completed_at: null, properties: {} }));

test('complete task pagination and details use bounded parallel reads while preserving order and progress', async () => {
  let pages = 0;
  let details = 0;
  let peakPages = 0;
  let peakDetails = 0;
  let calls = 0;
  const progress = [];
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async (_site, path, params) => {
      calls++;
      if (path === '/api/agile/work-items') {
        peakPages = Math.max(peakPages, ++pages);
        await new Promise(resolve => setTimeout(resolve, 10));
        pages--;
        return { value: rows.slice(params.pi * 2, (params.pi + 1) * 2), count: 8, page_index: params.pi, page_size: 2 };
      }
      peakDetails = Math.max(peakDetails, ++details);
      const index = Number(path.split('/').at(-1));
      await new Promise(resolve => setTimeout(resolve, 12 - index));
      details--;
      return { value: { ...rows[index], properties: { renwujiazhifen: index } } };
    }
  });
  const result = await client.tasks({ assigneeId: 'person', projectId: 'p', onProgress: value => progress.push(value) });
  assert.deepEqual(result.map(row => row.id), rows.map(row => row._id));
  assert.deepEqual(result.map(row => row.score), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peakPages, 3);
  assert.equal(peakDetails, 4);
  assert.equal(calls, 12, 'parallel reads must not fetch extra pages or duplicate details');
  assert.deepEqual(progress.at(-1), { phase: 'details', loaded: 8, total: 8 });
});

test('a failed parallel detail cancels in-flight reads and does not schedule the remaining queue', async () => {
  let started = 0;
  let aborted = 0;
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async (_site, path, _params, signal) => {
      if (path === '/api/agile/work-items') { return { value: rows, count: 8, page_index: 0, page_size: 100 }; }
      started++;
      if (path.endsWith('/0')) { throw Object.assign(Error('slow down'), { code: 'RATE_LIMITED' }); }
      await new Promise((resolve, reject) => {
        const abort = () => { aborted++; reject(Object.assign(Error('cancelled'), { code: 'CANCELLED' })); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); }
      });
    }
  });
  await assert.rejects(client.tasks({ assigneeId: 'person', projectId: 'p' }), error => error.code === 'RATE_LIMITED');
  assert.ok(started <= 4);
  assert.equal(aborted, started - 1);
});

test('parallel pagination rejects a failed page without starting detail reads', async () => {
  let details = 0;
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async (_site, path, params) => {
      if (path !== '/api/agile/work-items') { details++; return {}; }
      if (params.pi === 2) { throw Object.assign(Error('forbidden'), { code: 'FORBIDDEN' }); }
      return { value: rows.slice(params.pi * 2, (params.pi + 1) * 2), count: 8, page_index: params.pi, page_size: 2 };
    }
  });
  await assert.rejects(client.tasks({ assigneeId: 'person', projectId: 'p' }), error => error.code === 'FORBIDDEN');
  assert.equal(details, 0);
});

test('user cancellation aborts all parallel details and prevents the rest of the queue', async () => {
  const controller = new AbortController();
  let active = 0;
  let started = 0;
  const client = new WebClient({ site: 'https://example.pingcode.com', valueKey: 'renwujiazhifen' }, {
    read: async (_site, path, _params, signal) => {
      if (path === '/api/agile/work-items') { return { value: rows, count: 8, page_index: 0, page_size: 100 }; }
      active++;
      started++;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          active--;
          reject(Object.assign(Error('cancelled'), { code: 'CANCELLED' }));
        }, { once: true });
        if (started === 4) { queueMicrotask(() => controller.abort()); }
      });
    }
  });
  await assert.rejects(client.tasks({ assigneeId: 'person', projectId: 'p' }, controller.signal), error => error.code === 'CANCELLED');
  assert.equal(started, 4);
  assert.equal(active, 0);
});

test('changing counts across parallel pages cannot publish a truncated successful result', async () => {
  const client = new WebClient({ site: 'https://example.pingcode.com' }, {
    read: async (_site, _path, { pi }) => ({ value: rows.slice(pi * 2, (pi + 1) * 2),
      count: pi === 1 ? 4 : 8, page_index: pi, page_size: 2 })
  });
  await assert.rejects(client.pages('/api/agile/work-items', {}), /变化|完整/);
});

test('an already fetched malformed later page must still be validated when the earlier page completes the count', async () => {
  const client = new WebClient({ site: 'https://example.pingcode.com' }, {
    read: async (_site, _path, { pi }) => pi === 2 ? { value: null, count: 8, page_index: pi }
      : { value: pi === 1 ? rows.slice(2) : rows.slice(0, 2), count: 8, page_index: pi, page_size: 2 }
  });
  await assert.rejects(client.pages('/api/agile/work-items', {}), /响应/);
});
