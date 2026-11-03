// xterm's virtual viewport handles wheels, but has no native touch scroller.
// Use its public scroll API for history and its wheel path for mouse-reporting TUIs.
export function mountTerminalTouch(screen, terminal) {
  let gesture;
  const start = event => {
    if (event.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, previousY: touch.clientY, remainder: 0, scrolling: false };
  };
  const move = event => {
    if (!gesture || event.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) {
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
    if (terminal.buffer.active.type === 'normal' && !terminal.element.classList.contains('enable-mouse-events')) {
      const height = screen.querySelector('.xterm-screen').getBoundingClientRect().height / terminal.rows;
      gesture.remainder += deltaY / height;
      const lines = Math.trunc(gesture.remainder);
      if (lines) {
        terminal.scrollLines(lines);
        gesture.remainder -= lines;
      }
      return;
    }
    if (deltaY) {
      screen.querySelector('.xterm-screen')?.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        clientX: touch.clientX, clientY: touch.clientY
      }));
    }
  };
  const end = () => { gesture = null; };
  screen.addEventListener('touchstart', start, { passive: true });
  screen.addEventListener('touchmove', move, { passive: false });
  screen.addEventListener('touchend', end);
  screen.addEventListener('touchcancel', end);
  return () => {
    gesture = null;
    screen.removeEventListener('touchstart', start);
    screen.removeEventListener('touchmove', move);
    screen.removeEventListener('touchend', end);
    screen.removeEventListener('touchcancel', end);
  };
}
