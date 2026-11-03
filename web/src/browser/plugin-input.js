import './plugin-input.css';

// Browser input adaptation for virtual terminal widgets, independent of plugin ownership.
let gesture;
document.addEventListener('touchstart', event => {
  const terminal = event.target.closest('.xterm');
  if (!terminal || event.touches.length !== 1) {
    gesture = null;
    return;
  }
  const touch = event.touches[0];
  gesture = { terminal, id: touch.identifier, x: touch.clientX, y: touch.clientY, previousY: touch.clientY, scrolling: false };
}, { passive: true });
document.addEventListener('touchmove', event => {
  if (!gesture || event.touches.length !== 1) {
    gesture = null;
    return;
  }
  const touch = event.touches[0];
  if (touch.identifier !== gesture.id || !gesture.terminal.isConnected) {
    gesture = null;
    return;
  }
  if (!gesture.scrolling) {
    const x = Math.abs(touch.clientX - gesture.x);
    const y = Math.abs(touch.clientY - gesture.y);
    if (Math.max(x, y) < 6) {
      return;
    }
    if (x > y) {
      gesture = null;
      return;
    }
    gesture.scrolling = true;
  }
  event.preventDefault();
  const deltaY = gesture.previousY - touch.clientY;
  gesture.previousY = touch.clientY;
  if (!deltaY) {
    return;
  }
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window,
    deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: touch.clientX, clientY: touch.clientY });
  // Chromium exposes zero legacy deltas on constructed events; xterm prefers them to deltaY.
  Object.defineProperties(wheel, { wheelDeltaY: { value: -deltaY * 3 }, wheelDeltaX: { value: 0 } });
  gesture.terminal.querySelector('.xterm-screen')?.dispatchEvent(wheel);
}, { passive: false });
for (const type of ['touchend', 'touchcancel', 'pagehide']) {
  window.addEventListener(type, () => { gesture = null; });
}
