import { pluginHostOrigin } from './plugin-host.js';
// Visibility only gates presentation work. Business events and backend tasks keep running.
export function pageLifecycle(target = window, page = document) {
  let shown = true;
  let disposed = false;
  const listeners = new Set();
  const visible = () => !disposed && shown && !page.hidden;
  let previous = visible();
  const notify = () => {
    const value = visible();
    if (value !== previous) {
      previous = value;
      listeners.forEach(listener => listener(value));
    }
  };
  const receive = event => {
    if (event.source === target.parent && event.origin === pluginHostOrigin(target.location, page.referrer) && event.data?.type === 'desk:visibility') {
      shown = event.data.visible === true;
      notify();
    }
  };
  const dispose = () => {
    disposed = true;
    notify();
    listeners.clear();
    target.removeEventListener('message', receive);
    page.removeEventListener('visibilitychange', notify);
    target.removeEventListener('pagehide', dispose);
  };
  target.addEventListener('message', receive);
  page.addEventListener('visibilitychange', notify);
  target.addEventListener('pagehide', dispose, { once: true });
  target.parent.postMessage({ type: 'desk:visibility-ready' }, pluginHostOrigin(target.location, page.referrer));
  return { visible, subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, dispose };
}

// Recursive timeouts avoid overlapping requests; showing a page triggers one catch-up refresh.
export function pollVisible(lifecycle, work, interval, { schedule = setTimeout, cancel = clearTimeout, onError = console.error } = {}) {
  let timer;
  let running = false;
  let stopped = false;
  const run = async () => {
    cancel(timer);
    timer = undefined;
    if (stopped || running || !lifecycle.visible()) {
      return;
    }
    running = true;
    try {
      await work();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (!stopped && lifecycle.visible()) {
        timer = schedule(run, interval);
      }
    }
  };
  const off = lifecycle.subscribe(() => {
    cancel(timer);
    timer = undefined;
    if (lifecycle.visible()) {
      void run();
    }
  });
  void run();
  return () => {
    stopped = true;
    cancel(timer);
    off();
  };
}
