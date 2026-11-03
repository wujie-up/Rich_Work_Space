import test from 'node:test';
import assert from 'node:assert/strict';
import { positionPopup } from '../src/resource/popup.js';

// Geometry checks cover the shared rule without starting any business plugin.
test('popup placement follows pointer or trigger, flips at edges, and keeps forms centered', () => {
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;
  const anchor = { getBoundingClientRect: () => ({ left: 20, right: 320, top: 100 }) };
  const panel = { offsetWidth: 180, offsetHeight: 120, style: {}, matches: () => true, querySelector: () => null };
  positionPopup(panel, anchor, { point: { x: 60, y: 130 } });
  assert.deepEqual(panel.style, { left: '68px', top: '130px' });
  positionPopup(panel, anchor);
  assert.deepEqual(panel.style, { left: '328px', top: '100px' });
  positionPopup(panel, anchor, { point: { x: 970, y: 680 } });
  assert.deepEqual(panel.style, { left: '782px', top: '572px' });
  globalThis.innerWidth = 300;
  panel.offsetWidth = 240;
  positionPopup(panel, anchor, { point: { x: 20, y: 100 } });
  assert.deepEqual(panel.style, { left: '28px', top: '100px' }, '宽菜单在窄窗口中仍靠近点击位置');
  panel.matches = () => false;
  panel.querySelector = () => ({});
  positionPopup(panel, anchor, { point: { x: 20, y: 100 } });
  assert.equal(panel.style.top, '100px', '嵌套菜单采用侧向定位');
  positionPopup(panel, anchor, { placement: 'center' });
  assert.deepEqual(panel.style, { left: '30px', top: '290px' });
  panel.querySelector = () => null;
  positionPopup(panel, anchor);
  assert.deepEqual(panel.style, { left: '30px', top: '290px' }, '既有大型内容弹窗仍居中');
  delete globalThis.innerWidth;
  delete globalThis.innerHeight;
});
