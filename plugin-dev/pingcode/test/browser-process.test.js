import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserSession } from '../src/main/common/browser-session.js';
import { createBrowserPlatform } from '../src/main/os/index.js';

test('owned Chrome profile persists login on close and logout clears only that profile',
  { timeout: 60000, skip: process.platform !== 'darwin' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pingcode-real-browser-'));
    const reports = [];
    const session = new BrowserSession({ root, platform: createBrowserPlatform({ ownProcesses: pids => reports.push(pids) }),
      connect: async endpoint => {
        const browser = await chromium.connectOverCDP(endpoint);
        await browser.contexts()[0].route('https://fixture.pingcode.com/**', async route => {
          if (new URL(route.request().url()).pathname === '/api/typhon/account/me') {
            const loggedIn = (route.request().headers().cookie || '').includes('fixture-session=present');
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify(loggedIn
              ? { code: 200, data: { me: { uid: 'fixture-user' } } } : { code: 401 }) });
          } else {
            await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Independent login fixture</title>' });
          }
        });
        return browser;
      }
    });
    t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true }); });
    session.open('https://fixture.pingcode.com');
    assert.equal((await session.check()).state, 'needs-login');
    await session.context.addCookies([{ name: 'fixture-session', value: 'present', url: 'https://fixture.pingcode.com',
      expires: Math.floor(Date.now() / 1000) + 3600 }]);
    assert.equal((await session.check()).state, 'connected');
    await session.close();
    assert.deepEqual(reports.at(-1), []);
    session.open('https://fixture.pingcode.com');
    assert.equal((await session.check()).state, 'connected', 'closing retains the plugin-owned login profile');
    await session.close({ logout: true });
    session.open('https://fixture.pingcode.com');
    assert.equal((await session.check()).state, 'needs-login', 'logout removes retained login');
    assert.ok(reports.some(pids => pids.length === 1));
  });
