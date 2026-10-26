import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fetchErrorEmails } from '../src/main/common/imap.js';

// A local IMAP fixture exercises the real protocol without depending on a public mailbox.
async function imapFixture(t, messages, { rejectLogin = false } = {}) {
  const server = net.createServer(socket => {
    socket.write('* OK fixture ready\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');
        respond(socket, line, messages, rejectLogin);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function respond(socket, line, messages, rejectLogin) {
  const [tag, name, ...rest] = line.split(' ');
  const command = (name || '').toUpperCase();
  if (command === 'LOGIN') {
    socket.write(rejectLogin ? `${tag} NO authentication failed\r\n` : `${tag} OK LOGIN completed\r\n`);
    return;
  }
  if (command === 'SELECT') {
    socket.write(`* ${messages.length} EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
    return;
  }
  if (command === 'SEARCH') {
    socket.write(`* SEARCH ${messages.map((entry, index) => index + 1).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
    return;
  }
  if (command === 'FETCH') {
    for (const id of expand(rest[0] || '')) {
      const raw = messages[id - 1];
      if (raw === undefined) {
        continue;
      }
      socket.write(`* ${id} FETCH (BODY[] {${Buffer.byteLength(raw, 'utf8')}}\r\n${raw})\r\n`);
    }
    socket.write(`${tag} OK FETCH completed\r\n`);
    return;
  }
  if (command === 'LOGOUT') {
    socket.write(`${tag} OK LOGOUT completed\r\n`);
    socket.end();
    return;
  }
  socket.write(`${tag} BAD unsupported\r\n`);
}

function expand(set) {
  return set.split(',').flatMap(part => {
    const [start, end] = part.split(':').map(Number);
    if (!Number.isInteger(start)) {
      return [];
    }
    if (!Number.isInteger(end)) {
      return [start];
    }
    return Array.from({ length: end - start + 1 }, (unused, index) => start + index);
  });
}

const message = (subject, body) => `From: ops@example.com\r\nTo: dev@example.com\r\nDate: Fri, 24 Oct 2026 08:00:00 +0800\r\n`
  + `Subject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

async function fetch(t, { port, keywords, limit = 5, sinceDays = 3 }) {
  return await fetchErrorEmails({ credential: { host: '127.0.0.1', port, security: 'none', username: 'tester', password: 'secret' },
    mailbox: 'INBOX', sinceDays, keywords, limit, scanLimit: 40, shouldStop: () => false, timeout: 4000 });
}

test('抓取邮件并按关键字过滤', async t => {
  const port = await imapFixture(t, [message('正常通知', '版本发布完成'), message('订单服务告警', 'ERROR 连接池耗尽\nINFO 心跳正常')]);
  const emails = await fetch(t, { port, keywords: ['ERROR'] });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].subject, '订单服务告警');
  assert.match(emails[0].text, /连接池耗尽/);
  assert.equal(emails[0].from, 'ops@example.com');
});

test('中文关键字与返回值数量限制生效', async t => {
  const port = await imapFixture(t, [message('旧告警', '报错：网关超时'), message('新告警', '异常：队列积压'),
    message('普通邮件', '日报已生成')]);
  const emails = await fetch(t, { port, keywords: ['报错', '异常'], limit: 2 });
  assert.deepEqual(emails.map(item => item.subject), ['新告警', '旧告警']);
});

test('账号或授权码被服务器拒绝时返回可读错误', async t => {
  const port = await imapFixture(t, [], { rejectLogin: true });
  await assert.rejects(fetch(t, { port, keywords: [] }), { code: 'IMAP_COMMAND_FAILED' });
});

test('运行停止时不再抓取邮件正文', async t => {
  const port = await imapFixture(t, [message('告警', 'ERROR 失败')]);
  await assert.rejects(fetchErrorEmails({ credential: { host: '127.0.0.1', port, security: 'none', username: 'tester', password: 'x' },
    mailbox: 'INBOX', sinceDays: 1, keywords: [], limit: 5, scanLimit: 10, shouldStop: () => true, timeout: 4000 }),
  { code: 'RUN_CANCELED' });
});

test('邮件账号凭据不会出现在抓取结果中', async t => {
  const port = await imapFixture(t, [message('告警', 'ERROR 失败')]);
  const emails = await fetch(t, { port, keywords: [] });
  assert.equal(emails.length, 1);
  assert.ok(!JSON.stringify(emails).includes('secret'));
});
