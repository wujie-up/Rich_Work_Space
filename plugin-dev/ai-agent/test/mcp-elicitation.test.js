import test from 'node:test';
import assert from 'node:assert/strict';
import { elicitationResult, elicitationOptions, authorizationUrl } from '../src/shared/mcp-elicitation.js';

const request = { mode: 'form', requestedSchema: { type: 'object', properties: {
  name: { type: 'string', minLength: 2, maxLength: 10 }, count: { type: 'integer', minimum: 0, maximum: 3 },
  enabled: { type: 'boolean' }, choice: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] },
  tags: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }] }, minItems: 1, maxItems: 2 },
  email: { type: 'string', format: 'email' }, date: { type: 'string', format: 'date' },
  instant: { type: 'string', format: 'date-time' }, uri: { type: 'string', format: 'uri' }
}, required: ['name', 'count', 'enabled', 'tags'] } };
const content = { name: '本地验证', count: 0, enabled: false, tags: ['x'], choice: 'a',
  email: 'test@example.com', date: '2024-02-29', instant: '2026-11-03T10:00:00+08:00', uri: 'mailto:test@example.com' };

test('MCP form replies preserve typed values and enforce native field constraints', () => {
  assert.deepEqual(elicitationResult(request, 'accept', content), { action: 'accept', content });
  for (const invalid of [{ name: 'a' }, { count: '1' }, { count: 4 }, { count: 1.5 }, { enabled: 'false' },
    { tags: [] }, { tags: ['z'] }, { tags: ['x', 'y', 'x'] }, { choice: 'b' }, { email: 'bad' },
    { date: '2025-02-29' }, { instant: 'yesterday' }, { uri: 'relative/path' }]) {
    assert.throws(() => elicitationResult(request, 'accept', { ...content, ...invalid }), /格式|范围|选项/);
  }
  assert.throws(() => elicitationResult(request, 'accept', {}), /必填/);
  assert.throws(() => elicitationResult(request, 'accept', { ...content, extra: true }), /字段/);
});

test('MCP URL, decline and cancel do not leak form values into their replies', () => {
  assert.deepEqual(elicitationResult({ mode: 'url' }, 'accept', content), { action: 'accept' });
  for (const action of ['decline', 'cancel']) {
    assert.deepEqual(elicitationResult(request, action, content), { action });
  }
  assert.throws(() => elicitationResult(request, 'yes', content), /结果/);
  assert.equal(authorizationUrl('https://example.com/auth?state=fixture'), 'https://example.com/auth?state=fixture');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', '/relative']) {
    assert.throws(() => authorizationUrl(url), /授权链接/);
  }
});

test('enum labels and extended native JSON forms retain their original values', () => {
  assert.deepEqual(elicitationOptions({ enum: ['a', 'b'], enumNames: ['甲', '乙'] }), [['a', '甲'], ['b', '乙']]);
  assert.deepEqual(elicitationOptions(request.requestedSchema.properties.tags.items), [['x', 'X'], ['y', 'Y']]);
  for (const mode of ['openai/form', 'openaiForm']) {
    const content = { nested: { value: ['native', 3] } };
    assert.deepEqual(elicitationResult({ mode }, 'accept', content), { action: 'accept', content });
  }
});
