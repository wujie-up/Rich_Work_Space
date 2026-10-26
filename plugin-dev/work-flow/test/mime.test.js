import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/main/common/mime.js';

const encodedWord = text => `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;

test('解析 RFC2047 主题与 quoted-printable 正文', () => {
  const raw = ['From: ops@example.com', `Subject: ${encodedWord('计费告警')}`,
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'ERROR =E8=BF=9E=E6=8E=A5=E8=B6=85=E6=97=B6', 'INFO heartbeat'].join('\r\n');
  const message = parseMessage(raw);
  assert.match(message.subject, /告警/);
  assert.match(message.text, /连接超时/);
});

test('解析 base64 正文与 HTML 备选部分', () => {
  const text = Buffer.from('ERROR 队列积压', 'utf8').toString('base64');
  const html = Buffer.from('<p>请查看 <b>ERROR</b> 详情</p>', 'utf8').toString('base64');
  const raw = ['From: alert@example.com', 'Subject: 队列告警', 'Content-Type: multipart/alternative; boundary="BOUND"', '',
    '--BOUND', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', html,
    '--BOUND', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', text,
    '--BOUND--'].join('\r\n');
  const message = parseMessage(raw);
  assert.equal(message.subject, '队列告警');
  // text/plain part wins over html even when html comes first.
  assert.match(message.text, /队列积压/);
  assert.ok(!message.text.includes('<p>'));
});

test('HTML 邮件被转换为可读文本', () => {
  const raw = ['From: alert@example.com', 'Subject: 异常', 'Content-Type: text/html; charset=utf-8', '',
    '<html><body><script>bad()</script><p>ERROR&nbsp;异常&amp;重试</p><br><span>结束</span></body></html>'].join('\r\n');
  const message = parseMessage(raw);
  assert.match(message.text, /ERROR 异常&重试/);
  assert.ok(!message.text.includes('bad()'));
  assert.ok(!message.text.includes('<p>'));
});
