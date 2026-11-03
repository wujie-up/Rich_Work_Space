import test from 'node:test';
import assert from 'node:assert/strict';
import { documentLinkAnswer } from '../src/renderer/document-link.js';

test('链接作为文本原样传递，保留查询参数、锚点及来源信息', () => {
  const url = 'https://example.feishu.cn/wiki/文档?version=1&view=full#需求';
  const answer = documentLinkAnswer(`  ${url}\n`);
  assert.deepEqual(answer, { text: url, file: { name: 'example.feishu.cn', size: new TextEncoder().encode(url).length, url } });
  assert.equal(documentLinkAnswer('http://127.0.0.1:1/unreachable').text, 'http://127.0.0.1:1/unreachable');
});

test('链接输入只校验 HTTP/HTTPS 地址格式', () => {
  for (const url of ['', '不是链接', 'file:///tmp/document.md', 'javascript:alert(1)', 'https://user:password@example.com/doc']) {
    assert.throws(() => documentLinkAnswer(url), /HTTP.*HTTPS/);
  }
});
