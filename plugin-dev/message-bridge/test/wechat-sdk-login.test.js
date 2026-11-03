import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WechatyBuilder, log } from 'wechaty';
import { createWechatPuppet, WechatChannel } from '../src/main/common/channels/wechat.js';

// Exercise the real SDK from QR polling through XML login and contact initialization, using only local protocol fixtures.
for (const denied of [false, true]) {
  test(`real Wechaty propagates ${denied ? 'platform login denial' : 'phone confirmation and logged-in account'}`, { timeout: 10000 }, async t => {
    log.level('silent');
    const directory = await mkdtemp(join(tmpdir(), 'wechat-login-fixture-'));
    let polls = 0;
    let qrRequests = 0;
    let initialized = false;
    const server = createServer((request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Content-Type', 'application/json');
      if (path.endsWith('/jslogin')) {
        qrRequests++;
        response.end('window.QRLogin.code=200;window.QRLogin.uuid="fixture";');
      } else if (path.endsWith('/login')) {
        response.end(++polls === 1 ? 'window.code=201;' : 'window.code=200;window.redirect_uri="https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxnewloginpage";');
      } else if (path.endsWith('/webwxnewloginpage')) {
        response.setHeader('Content-Type', 'text/xml');
        response.end(denied ? '<error><ret>1203</ret><message>当前账号无法登录网页版微信</message></error>'
          : '<error><ret>0</ret><skey>fixture-skey</skey><wxsid>fixture-sid</wxsid><wxuin>123</wxuin><pass_ticket>fixture-ticket</pass_ticket></error>');
      } else if (path.endsWith('/webwxinit')) {
        initialized = true;
        response.end(JSON.stringify({ BaseResponse: { Ret: 0 }, SyncKey: { List: [{ Key: 1, Val: 1 }] }, ContactList: [],
          User: { UserName: '@fixture-self', NickName: '测试账号', RemarkName: '' } }));
      } else if (path.endsWith('/synccheck')) {
        // Keep the long poll pending until stop() aborts it, rather than looping on an immediate fixture response.
        request.on('close', () => response.destroy());
      } else {
        response.end(JSON.stringify({ BaseResponse: { Ret: 0 }, MemberList: [], Seq: 0 }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const errors = [];
    const states = [];
    const puppet = await createWechatPuppet({}, { report: (action, error) => errors.push({ action, error }) });
    const patch = puppet.monkeyPatch.bind(puppet);
    puppet.monkeyPatch = client => {
      const request = client.request;
      client.request = options => request({ ...options, url: `http://127.0.0.1:${server.address().port}${new URL(options.url).pathname}` });
      patch(client);
    };
    const bot = WechatyBuilder.build({ name: join(directory, 'session'), puppet });
    let finish;
    const result = new Promise(resolve => { finish = resolve; });
    const channel = new WechatChannel({ pluginId: 'message-bridge', channel: { id: 'fixture' },
      report: (action, error) => errors.push({ action, error }),
      status: state => {
        states.push(state);
        if (state.state === 'connected' || state.state === 'error') { finish(state); }
      }, sdkFactory: async () => ({ bot, qr: async () => 'data:image/png;base64,fixture' }) });
    t.after(async () => {
      await channel.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    await channel.start();
    const status = await result;
    assert.ok(states.some(item => item.state === 'scanned'), '201 without an avatar still advances progress');
    assert.ok(states.some(item => item.state === 'confirming'));
    if (denied) {
      assert.match(status.error, /1203.*当前账号无法登录/);
      assert.equal(initialized, false, 'a denied login must never initialize contacts');
      await channel.drain();
      assert.equal(qrRequests, 1, 'a new QR must not mask the login error');
    } else {
      assert.equal(status.account, '测试账号');
      assert.equal(initialized, true);
      await puppet.wechat4u.restart();
      await new Promise(resolve => setImmediate(resolve));
      await channel.drain();
      assert.equal(states.filter(item => item.state === 'connected').length, 2, 'a live SDK reconnect logs in again cleanly');
      assert.deepEqual(errors, []);
    }
  });
}
