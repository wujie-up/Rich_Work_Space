import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { monitorPluginViews } from '../src/main/common/plugin-views.js';

for (const state of ['destroyed', 'detached']) {
  test(`view monitor skips a ${state} main frame and resumes on its replacement`, t => {
    t.mock.timers.enable({apis:['setInterval']});
    const contents = new EventEmitter();
    contents.isDestroyed = () => false;
    contents.mainFrame = {
      isDestroyed: () => state === 'destroyed',
      get detached() {
        assert.notEqual(state,'destroyed');
        return true;
      },
      get framesInSubtree() {
        throw Error('Render frame was disposed before WebFrameMain could be accessed');
      }
    };
    const failures = [];
    monitorPluginViews({getAppMetrics:()=>[]},contents,(...args)=>failures.push(args));
    t.after(()=>contents.emit('destroyed'));
    const frame = new EventEmitter();
    Object.assign(frame,{url:'desk-plugin://probe/view',osProcessId:42,executeJavaScript:async()=>{}});
    contents.emit('frame-created',{}, {frame});
    frame.emit('dom-ready');
    assert.doesNotThrow(()=>t.mock.timers.tick(500));
    assert.equal(failures.length,0);
    contents.mainFrame = {isDestroyed:()=>false,detached:false,framesInSubtree:[frame]};
    t.mock.timers.tick(500);
    assert.equal(failures.length,1);
    assert.equal(failures[0][0],'probe');
    assert.equal(failures[0][1].code,'PLUGIN_VIEW_CRASHED');
    contents.emit('destroyed');
    Object.defineProperty(contents, 'mainFrame', {
      get: () => {
        throw Error('timer should have stopped');
      }
    });
    assert.doesNotThrow(()=>t.mock.timers.tick(500));
  });
}
