import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, configure, create, output, owner, openWorkspace } from '../../../../desk/test/electron/helpers.js';

test('workspace uses compact controls and double clicking the session title does not rename', async (t) => {
  const { page } = await launch(t, { disabledPlugins: ['resource-monitor'] });
  await configure(page);
  const session = await create(page, '紧凑会话');
  const view = page.frameLocator('iframe.plugin-view[title="AI Agent 会话"]');
  await output(page, session.id, 'READY 中文');
  const card = view.locator('.session');
  await card.locator('.session-header').dblclick();
  assert.equal(await view.locator('dialog').count(), 0);
  assert.equal(await view.getByRole('heading', { name: '会话工作台', exact: true }).count(), 0);
  assert.equal(await view.locator('.page-heading .badge').count(), 0);
  assert.equal(await view.getByRole('button', { name: 'CLI 配置', exact: true }).isVisible(), false);
  const tools = view.getByRole('button', { name: '工作台操作', exact: true });
  assert.equal(await tools.innerText(), '');
  assert.equal(await tools.evaluate(node => getComputedStyle(node).borderTopStyle), 'none');
  assert.equal(await tools.locator('svg').evaluate(node => getComputedStyle(node).fill), 'none');
  assert.ok(Number(await tools.locator('svg').evaluate(node => getComputedStyle(node).strokeWidth.replace('px', ''))) <= 2);
  const menu = view.locator('.workspace-menu');
  await tools.hover();
  assert.equal(await menu.isVisible(), false, 'hover alone must not open settings');
  await tools.focus();
  assert.equal(await menu.isVisible(), false, 'focus alone must not open settings');
  await tools.click();
  assert.equal(await tools.getAttribute('aria-expanded'), 'true');
  const triggerBox = await tools.boundingBox();
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox.x + menuBox.width <= triggerBox.x, 'settings must expand to the left');
  await tools.click();
  assert.equal(await menu.isVisible(), false, 'clicking again must close settings');
  await tools.click();
  await card.getByRole('button', { name: '改名', exact: true }).focus();
  assert.equal(await menu.isVisible(), false, 'moving focus outside must close settings');
  await tools.click();
  await card.locator('.session-header').hover();
  assert.equal(await menu.isVisible(), false, 'leaving the settings area must close settings');
  await tools.click();
  for (const name of ['CLI 配置', '历史', '新建会话']) {
    if (!await menu.isVisible()) { await tools.click(); }
    const action = menu.getByRole('button', { name, exact: true, includeHidden: true });
    assert.equal(await action.innerText(), '');
    assert.equal(await action.getAttribute('title'), name);
    assert.equal(await action.locator('svg').count(), 1);
    assert.equal(await action.evaluate(node => getComputedStyle(node).borderTopStyle), 'none');
    assert.equal(await action.locator('svg').evaluate(node => getComputedStyle(node).fill), 'none');
  }
  assert.ok((await menu.boundingBox()).height <= 40, 'expanded actions must fit in a compact icon row');
  await view.getByRole('button', { name: 'CLI 配置', exact: true }).click();
  assert.ok((await view.locator('dialog').boundingBox()).width <= 440);
  assert.equal(await view.locator('.dialog-heading h2').evaluate(node => getComputedStyle(node).fontSize), '14px');
  await view.getByRole('button', { name: '取消', exact: true }).click();
  for (const name of ['改名', '折叠', '关闭']) {
    assert.equal(await card.getByRole('button', { name, exact: true }).innerText(), '');
  }
  const expanded = await card.boundingBox();
  await card.getByRole('button', { name: '折叠', exact: true }).click();
  assert.match(await card.getAttribute('class'), /collapsed/);
  const collapsed = await card.boundingBox();
  await page.mouse.move(collapsed.x + collapsed.width - 3, collapsed.y + collapsed.height - 3);
  await page.mouse.down();
  await page.mouse.move(collapsed.x + collapsed.width - 143, collapsed.y + collapsed.height - 3, { steps: 8 });
  await page.mouse.up();
  const resized = await card.boundingBox();
  assert.ok(resized.width < collapsed.width - 100, 'collapsed sessions must support horizontal resizing');
  assert.equal(Math.round(resized.height), Math.round(collapsed.height));
  await page.waitForTimeout(350);
  const layout = await page.evaluate(owner => agentDesk.storage.getLayout(owner), owner);
  assert.ok(layout.collapsed.includes(session.id));
  assert.equal(Math.round(layout.sizes[session.id].width), Math.round(resized.width));
  assert.equal(Math.round(layout.sizes[session.id].height), Math.round(expanded.height));
  await page.reload();
  await openWorkspace(page);
  await card.waitFor();
  assert.match(await card.getAttribute('class'), /collapsed/);
  await card.getByRole('button', { name: '展开', exact: true }).click();
  await view.locator('.session:not(.collapsed)').waitFor();
  assert.doesNotMatch(await card.getAttribute('class'), /collapsed/);
  assert.equal(Math.round((await card.boundingBox()).width), Math.round(resized.width));
  assert.equal(Math.round((await card.boundingBox()).height), Math.round(expanded.height));
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/ai-compact-workspace.png') });
  await card.getByRole('button', { name: '关闭', exact: true }).locator('svg').click();
  await view.getByRole('heading', { name: '关闭会话', exact: true }).waitFor();
  await view.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(owner => agentDesk.sessions.list(owner), owner)).sessions.length, 1);
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await view.getByRole('button', { name: '确认', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  const archived = await page.evaluate(owner => agentDesk.sessions.list(owner), owner);
  assert.equal(archived.sessions.length, 0);
  assert.equal(archived.archives.length, 1);
});

test('terminal image paste saves the bitmap and sends a path once; text and Chinese input still work', async (t) => {
  let app;
  // Register before launch's cleanup so the real clipboard is restored while Electron is still running.
  t.after(async () => {
    if (app) {
      await app.evaluate(async ({ clipboard }) => clipboard.write(globalThis.aiTestClipboard));
    }
  });
  const launched = await launch(t, { disabledPlugins: ['resource-monitor'] });
  const { page } = launched;
  app = launched.app;
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.aiTestClipboard = await Promise.all((await clipboard.read()).map(async (item) => new ClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))));
  });
  await configure(page);
  const session = await create(page, '图片粘贴');
  await output(page, session.id, 'READY 中文');
  const input = page.frameLocator('iframe.plugin-view[title="AI Agent 会话"]').locator('.xterm-helper-textarea');
  await input.focus();
  const clipboardState = await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const bitmap = Buffer.alloc(640 * 640 * 4);
    let value = 1;
    for (let i = 0; i < bitmap.length; i++) {
      value = (1664525 * value + 1013904223) >>> 0;
      bitmap[i] = value >>> 24;
    }
    const png = nativeImage.createFromBitmap(bitmap, { width: 640, height: 640 }).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return { hasImage: await clipboard.has('image/png'), types: (await clipboard.read()).map(item => item.types) };
  });
  assert.equal(clipboardState.hasImage, true, JSON.stringify(clipboardState));
  await page.keyboard.press('Meta+v');
  const snapshot = await output(page, session.id, /clipboard-[a-f0-9-]+\.png/);
  const path = snapshot.data.match(/(\/[^\r\n]*?clipboard-[a-f0-9-]+\.png)/)[1];
  assert.ok((await readFile(path)).length > 1024 * 1024, 'large images cross the host message limit using chunks');
  assert.equal(snapshot.data.match(/clipboard-[a-f0-9-]+\.png/g).length, 1);
  await app.evaluate(({ clipboard }) => clipboard.writeText('普通粘贴 中文'));
  await page.keyboard.press('Meta+v');
  await output(page, session.id, '普通粘贴 中文');
  await page.keyboard.insertText('输入中文');
  await output(page, session.id, '输入中文');
  const composition = page.frameLocator('iframe.plugin-view[title="AI Agent 会话"]').locator('.composition-view');
  await input.evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(new CompositionEvent('compositionupdate', { data: '拼音', bubbles: true }));
  });
  assert.equal(await composition.innerText(), '拼音');
  assert.equal(await composition.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })));
  await page.keyboard.press('Meta+v');
  await output(page, session.id, /普通粘贴 中文[\s\S]*普通粘贴 中文/);
});

test('draft controls work before the CLI reports an idle state and newline does not submit', async (t) => {
  const { page } = await launch(t, { disabledPlugins: ['resource-monitor'] });
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner,
    { codex: { mode: 'legacy', command, args } }), { owner, command: process.execPath, args: [resolve('desk/test/fixtures/pty-cli.cjs')] });
  const session = await page.evaluate(({ owner, cwd }) => agentDesk.sessions.create(owner,
    { adapterId: 'codex', name: '输入操作', cwd }), { owner, cwd: resolve('.') });
  await output(page, session.id, 'READY 中文');
  const view = page.frameLocator('iframe.plugin-view[title="AI Agent 会话"]');
  for (const name of ['清空输入', '换行', '分叉']) {
    const control = view.getByRole('button', { name, exact: true });
    assert.equal(await control.innerText(), '');
    assert.equal(await control.locator('svg').count(), 1);
    assert.equal(await control.locator('svg').evaluate(node => getComputedStyle(node).fill), 'none');
  }
  const clear = view.getByRole('button', { name: '清空输入', exact: true });
  assert.equal(await clear.isEnabled(), true);
  await clear.click();
  await output(page, session.id, /\\u001b\[200~ \\u001b\[201~\\u0003/);
  await view.getByRole('button', { name: '换行', exact: true }).click();
  await output(page, session.id, /\\u001b\[13;2u/);
  assert.equal(await view.locator('.xterm-helper-textarea').evaluate(node => node === document.activeElement), true);
});
