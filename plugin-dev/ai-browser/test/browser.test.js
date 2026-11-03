import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserSession } from '../src/main/common/browser.js';
import { compactSnapshot, safeUrl } from '../src/main/common/observation.js';
import { createBrowserPlatform } from '../src/main/os/index.js';
import { localHtmlUrl } from '../src/main/common/html-file.js';
import { pathToFileURL } from 'node:url';

test('local HTML resolves relative paths with spaces and rejects other files before launching', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-html-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '预览 #1.html');
  await writeFile(path, '<h1>Local</h1>');
  await writeFile(join(root, 'secret.txt'), 'not html');
  assert.equal(await localHtmlUrl({ path: '预览 #1.html', cwd: root }), pathToFileURL(await realpath(path)).href);
  assert.equal(await localHtmlUrl({ path }), pathToFileURL(await realpath(path)).href);
  await assert.rejects(localHtmlUrl({ path: join(root, 'secret.txt') }), /HTML/);
  await assert.rejects(localHtmlUrl({ path: 'preview.html' }), /工作目录/);
  await assert.rejects(localHtmlUrl({ path: join(root, 'missing.html') }));
});

test('URLs reject native protocols and embedded credentials', () => {
  assert.equal(safeUrl('example.com'), 'https://example.com/');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.com', 'chrome://settings']) {
    assert.throws(() => safeUrl(url));
  }
});

test('compact snapshots remove static noise, bound output and paginate without loss', () => {
  const source = '- heading "Hello"\n- button "Save" [ref=e1]\n- paragraph: irrelevant\n- textbox "Name" [ref=e2]';
  assert.equal(compactSnapshot(source, {}).text, '- heading "Hello"\n- button "Save" [ref=e1]\n- textbox "Name" [ref=e2]');
  const first = compactSnapshot(source, { maxChars: 40 });
  assert.equal(first.text.length, 40);
  assert.equal(first.nextOffset, 40);
  assert.equal(first.text + compactSnapshot(source, { offset: 40, maxChars: 1000 }).text, compactSnapshot(source, {}).text);
  assert.equal(compactSnapshot(source, { query: 'Save' }).text, '- button "Save" [ref=e1]');
});

test('real visible Chromium shares tabs with user and provides bounded native Agent control', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ai-browser-'));
  const pids = [];
  const platform = createBrowserPlatform({ ownProcesses: owned => pids.splice(0, pids.length, ...owned) });
  const session = new BrowserSession({ root, platform, chromium, executable: chromium.executablePath() });
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<title>Fixture</title><h1>Browser fixture</h1><label>Name<input aria-label="Name"></label>
      <button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button>
      <output>Waiting</output><p>${'Static article content. '.repeat(2000)}</p>
      <a href="/next">Next</a><button onclick="window.open('/popup')">Popup</button>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await session.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await session.act({ steps: [{ op: 'open', url }] });
  assert.ok(pids.length === 1, 'only the current browser process group is registered');
  const [tab] = await session.tabs();
  const local = join(root, '报告 预览.html');
  await writeFile(join(root, 'local.js'), 'document.querySelector("output").textContent="asset loaded"');
  await writeFile(local, '<title>Local preview</title><h1>Local report</h1><output></output><script src="./local.js"></script>');
  const preview = await session.openHtml({ path: '报告 预览.html', cwd: root });
  assert.equal(await session.page(preview.tabId).locator('output').innerText(), 'asset loaded');
  assert.equal((await session.tabs()).length, 2, 'local preview keeps existing webpage');
  assert.match((await session.observe({ tabId: preview.tabId })).text, /Local report/);
  await session.act({ tabId: preview.tabId, steps: [{ op: 'closeTab' }] });
  const first = await session.observe({ tabId: tab.id });
  assert.ok(first.text.length < 4000);
  t.diagnostic(`fixture body=${(await session.page(tab.id).locator('body').innerText()).length} chars; default observation=${first.text.length} chars`);
  assert.doesNotMatch(first.text, /Static article/);
  assert.equal((await session.observe({ tabId: tab.id, since: first.snapshotId })).unchanged, true);
  const nameRef = first.text.match(/textbox "Name" \[ref=(\w+)\]/)[1];
  const saveRef = first.text.match(/button "Save" \[ref=(\w+)\]/)[1];
  const saved = await session.act({ tabId: tab.id, snapshotId: first.snapshotId, steps: [
    { op: 'fill', ref: nameRef, value: 'Ada' }, { op: 'click', ref: saveRef }
  ] });
  assert.equal(saved.completed, 2);
  assert.ok(JSON.stringify(saved).length < 500, 'actions return acknowledgements without DOM dumps');
  assert.match((await session.observe({ tabId: tab.id, mode: 'text', selector: 'output' })).text, /Ada/);
  const failed = await session.act({ tabId: tab.id, steps: [
    { op: 'fill', selector: 'input', value: 'Grace' }, { op: 'click', selector: '#missing' },
    { op: 'fill', selector: 'input', value: 'Must not execute' }
  ] });
  assert.equal(failed.completed, 1);
  assert.equal(failed.failedStep, 1);
  assert.equal(await session.page(tab.id).locator('input').inputValue(), 'Grace');
  const shot = await session.screenshot({ tabId: tab.id });
  assert.equal(shot.content[0].type, 'image');
  assert.ok(JSON.stringify(shot).length < 1024 * 1024);
  await session.page(tab.id).evaluate(() => localStorage.setItem('retained', 'yes'));
  await session.act({ tabId: tab.id, steps: [{ op: 'open', url: `${url}/next` }] });
  await assert.rejects(session.act({ tabId: tab.id, snapshotId: first.snapshotId, steps: [{ op: 'click', ref: saveRef }] }), /快照/);
  await assert.rejects(session.act({ steps: [{ op: 'open', url: 'file:///tmp' }] }));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(session.act({ steps: [{ op: 'newTab', url }] }, { signal: cancelled.signal }), /取消/);
  assert.equal((await session.tabs()).length, 1);
  await session.act({ tabId: tab.id, steps: [{ op: 'click', selector: 'button:last-of-type' }] });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await session.tabs()).length, 2, 'native popups become controllable tabs');
  await session.close();
  assert.deepEqual(pids, []);
  await session.act({ steps: [{ op: 'open', url }] });
  const [reopened] = await session.tabs();
  assert.equal(await session.page(reopened.id).evaluate(() => localStorage.getItem('retained')), 'yes');
  await session.close();
});
