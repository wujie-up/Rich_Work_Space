import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { extractFile } from '@electron/asar';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { launch } from './helpers.js';

test('disposed native main frames do not escape the monitor and a replacement remains monitored', {timeout:30000}, async t => {
  const {app} = await launch(t,{openPlugin:false,executablePath:process.env.WORK_DESK_TEST_EXECUTABLE});
  const source = process.env.WORK_DESK_TEST_EXECUTABLE
    ? extractFile(resolve(dirname(process.env.WORK_DESK_TEST_EXECUTABLE),'../Resources/app.asar'),
      'desk/src/main/common/plugin-views.js').toString()
    : await readFile('desk/src/main/common/plugin-views.js','utf8');
  const result = await app.evaluate(async ({app,BrowserWindow},source) => {
    const monitorPluginViews = new Function(`${source}; return monitorPluginViews;`)();
    const probe = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    await probe.loadURL('data:text/html,frame-monitor-probe');
    const old = probe.webContents.mainFrame;
    probe.destroy();
    const listeners = new Map();
    const contents = {on:(name,fn)=>listeners.set(name,fn),once:(name,fn)=>listeners.set(name,fn)};
    contents.isDestroyed = () => false;
    contents.mainFrame = old;
    const errors = [];
    const failures = [];
    const capture = error => errors.push(error.message);
    process.on('uncaughtException',capture);
    let nativeError;
    try {
      monitorPluginViews(app,contents,(id,error)=>failures.push({id,...error}));
      await new Promise(resolve=>setTimeout(resolve,650));
      try {
        old.framesInSubtree;
      } catch (error) {
        nativeError = error.message;
      }
      const replacement = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
      try {
        await replacement.loadURL('data:text/html,replacement-monitor-probe');
        contents.mainFrame = replacement.webContents.mainFrame;
        const frame = {
          on: (_name, fn) => {
            frame.ready = fn;
          }
        };
        Object.assign(frame,{url:'desk-plugin://probe/view',osProcessId:-1,executeJavaScript:async()=>{}});
        listeners.get('frame-created')({}, {frame});
        frame.ready();
        await new Promise(resolve=>setTimeout(resolve,550));
        return {destroyed:old.isDestroyed(),nativeError,errors,failures};
      } finally {
        replacement.destroy();
      }
    } finally {
      listeners.get('destroyed')();
      process.removeListener('uncaughtException',capture);
    }
  },source.replace('export function','function'));
  await mkdir('.test-results/frame-monitor',{recursive:true});
  await writeFile('.test-results/frame-monitor/native.json',JSON.stringify(result,null,2));
  assert.equal(result.destroyed,true);
  assert.match(result.nativeError,/Render frame was disposed/);
  assert.deepEqual(result.errors,[]);
});
