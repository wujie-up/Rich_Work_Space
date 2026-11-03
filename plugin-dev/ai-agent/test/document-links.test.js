import test from 'node:test';
import assert from 'node:assert/strict';
import { documentEntry, documentLinks } from '../src/renderer/document-links.js';

test('document links identify local generated files with spaces and exclude URLs or commands', () => {
  const text = '文档 [方案](docs/技术 方案.md) 和 `/tmp/result.sql:12`，https://example.com/readme.md，`rm -rf /tmp`';
  const links = documentLinks(text);
  assert.deepEqual(links.map(link => link.path), ['docs/技术 方案.md', '/tmp/result.sql']);
  for (const link of links) { assert.equal(text.slice(link.start, link.end).includes(link.path), true); }
});

test('HTML links route to the browser while source and document links keep the text editor', () => {
  assert.equal(documentEntry('/tmp/报告 预览.HTML'), 'browser-document');
  assert.equal(documentEntry('report.htm'), 'browser-document');
  for (const path of ['readme.md', 'report.html.js', 'config.json']) {
    assert.equal(documentEntry(path), 'text-document');
  }
});
