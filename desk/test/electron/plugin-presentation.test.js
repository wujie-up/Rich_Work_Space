import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from './helpers.js';

test('retained sandbox pages suspend display polling while background events and sibling pages keep running', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false });
  await page.evaluate(async () => {
    for (const plugin of await workDesk.plugins.list()) {
      if (plugin.state === 'enabled') {
        const preview = await workDesk.plugins.preview(plugin.id, 'disable');
        await workDesk.plugins.disable(plugin.id, preview.confirmationToken);
      }
    }
  });
  const ids = ['presentation-one', 'presentation-two'];
  for (const id of ids) {
    const source = join(data, `source-${id}`);
    await mkdir(source);
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 2,
      dataVersion: 1, main: 'index.mjs', singleInstance: true }));
    await writeFile(join(source, 'index.mjs'), `let timer;
      export function activate(c) {
        let ticks=0, polls=0;
        c.views.register({id:'main',title:'${id}',entry:'index.html'});
        c.methods.register('poll',()=>({ticks,polls:++polls}));
        c.methods.register('stats',()=>({ticks,polls}));
        timer=setInterval(()=>{ticks++;c.emit('tick',{ticks});},100);
      }
      export function deactivate(){clearInterval(timer);}`);
    await copyFile('desk/src/resource/page-lifecycle.js', join(source, 'page-lifecycle.js'));
    await copyFile('plugin-dev/resource-monitor/src/renderer/api.js', join(source, 'api.js'));
    await writeFile(join(source, 'index.html'), `<h1>${id}</h1><script type="module">
      import {pageLifecycle,pollVisible} from './page-lifecycle.js';
      import {invoke} from './api.js';
      window.stats={events:0,polls:0};
      const lifecycle=pageLifecycle();
      window.addEventListener('message',e=>{
        if(e.source===parent&&e.origin==='desk-host://desktop'&&e.data?.type==='desk:event'){
          window.stats.events++;window.stats.owner=e.data.pluginId;
        }
      });
      pollVisible(lifecycle,async()=>{window.stats.polls++;window.stats.last=await invoke('poll');},100);
      window.visible=lifecycle.visible;
    </script>`);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, source);
    await page.evaluate(() => workDesk.plugins.install());
  }
  const frame = id => page.frames().find(value => value.url().startsWith(`desk-plugin://${id}/`));
  await page.locator('.shelf-app[data-plugin="presentation-one"]').click();
  await page.frameLocator('iframe[src^="desk-plugin://presentation-one/"]').getByRole('heading').waitFor();
  await frame(ids[0]).waitForFunction(() => window.stats?.polls >= 2);
  await page.locator('#desktop').click();
  await page.locator('.shelf-app[data-plugin="presentation-two"]').click();
  await page.frameLocator('iframe[src^="desk-plugin://presentation-two/"]').getByRole('heading').waitFor();
  await frame(ids[1]).waitForFunction(() => window.stats?.polls >= 2);
  await frame(ids[0]).waitForFunction(() => !window.visible());
  // Allow an already issued request to settle before comparing counts.
  await delay(150);
  const before = await frame(ids[0]).evaluate(() => ({ ...stats }));
  const other = await frame(ids[1]).evaluate(() => stats.polls);
  await delay(450);
  const hidden = await frame(ids[0]).evaluate(() => ({ ...stats }));
  assert.equal(hidden.polls, before.polls);
  assert.ok(hidden.events > before.events, 'business events continue for the hidden page');
  assert.equal(hidden.owner, ids[0]);
  assert.ok(await frame(ids[1]).evaluate(() => stats.polls) > other);
  const backend = await page.evaluate(id => workDesk.plugins.invoke(id, 'stats', []), ids[0]);
  assert.ok(backend.ticks > before.last.ticks, 'hidden plugin background continues');
  await page.getByRole('tab', { name: ids[0], exact: true }).click();
  await frame(ids[0]).waitForFunction(previous => window.visible() && stats.polls > previous, hidden.polls);
  assert.equal(await frame(ids[1]).evaluate(() => window.visible()), false);
  const resume = await frame(ids[0]).evaluate(() => stats.polls);
  assert.ok(resume > hidden.polls);
  console.log(JSON.stringify({ hiddenPollsAdded: hidden.polls-before.polls, hiddenEventsAdded: hidden.events-before.events,
    backendTicks: backend.ticks, resumedPolls: resume-hidden.polls }));
});
