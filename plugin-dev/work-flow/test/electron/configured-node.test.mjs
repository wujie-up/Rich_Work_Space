import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createRegistry } from '../../src/main/common/nodes.js';
import { visibleNodeParams } from '../../src/shared/node-params.js';

test('configured node form renders actual mode/language fields in light/dark and narrow/normal layouts', async t => {
  const source=await readFile(resolve('plugin-dev/work-flow/src/renderer/app.js'),'utf8');
  const properties=source.slice(source.indexOf('function renderProperties()'),source.indexOf('// Read the submitted snapshot;'));
  const fields=source.slice(source.indexOf('function paramHtml('),source.indexOf('function insertVariable('));
  const type=createRegistry({credentials:{},logger:()=>{}}).list().find(type=>type.type==='custom.configured');
  const styles=await Promise.all(['desk/src/resource/controls.css','plugin-dev/work-flow/src/renderer/style.css'].map(path=>readFile(resolve(path),'utf8')));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<style>${styles.join('\n')}</style><aside class="inspector" style="width:100%;max-width:460px;box-sizing:border-box">
    <div id="workflow-properties"></div><div id="message-connections"></div><div id="mail-credentials"></div>
    <div id="properties"></div></aside>`);
  await page.evaluate(({type,properties,fields,visibility})=>{
    const node={id:'custom',type:'custom.configured',title:'自定义步骤',params:{}};
    const state={selectedNodeId:'custom',selectedEdge:null,dirty:false,providerInfo:{providers:[]},connections:[],credentials:[]};
    const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const factory=new Function('state','nodeOf','typeOf','availableVariables','escape','feishuRobotPanel','messagePanel','current',
      'removeNode','removeEdge','renderCanvas','renderTriggers','renderSelectedFile',`${visibility}\n${fields}\n${properties}\nreturn renderProperties;`);
    const render=factory(state,()=>node,()=>type,()=>[],escape,{show(){}},{render(){}},()=>({}),()=>{},()=>{},()=>{},()=>{},()=>{});
    window.fixture={reset(){node.params={};render();},params:()=>node.params};window.fixture.reset();
  },{type,properties,fields,visibility:visibleNodeParams.toString()});
  const output=resolve('.test-results/work-flow');await mkdir(output,{recursive:true});
  for(const theme of ['light','dark'])for(const width of [320,900]) {
    await page.setViewportSize({width,height:850});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.fixture.reset();},theme);
    assert.equal(await page.locator('[data-param="code"]').count(),0);
    const mode=page.locator('[data-param="mode"]');await mode.focus();await mode.selectOption('script');
    await page.waitForSelector('[data-param="code"]');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.param),'mode');
    assert.equal(await page.locator('[data-param="pythonExecutable"]').count(),0);
    await page.locator('[data-param="language"]').selectOption('python');
    await page.locator('[data-param="pythonExecutable"]').fill('/usr/bin/python3');
    await page.locator('[data-param="code"]').fill('return {"literal":"{{unchanged}}"}');
    assert.equal((await page.evaluate(()=>window.fixture.params())).code,'return {"literal":"{{unchanged}}"}');
    await page.locator('[data-param="language"]').focus();await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(()=>Boolean(document.activeElement)));
    await page.screenshot({path:resolve(output,`configured-node-${theme}-${width}.png`)});
    await page.locator('[data-param="code"]').evaluate(element=>{element.disabled=true;});
    assert.equal(await page.locator('[data-param="code"]').isDisabled(),true);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('[data-param="mode"]').selectOption('transform');
    assert.equal(await page.locator('[data-param="code"]').count(),0);
    assert.equal(await page.locator('[data-param="language"]').count(),0);
  }
  assert.deepEqual(errors,[]);
});
