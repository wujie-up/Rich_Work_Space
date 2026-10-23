// Electron does not emit the main webContents crash event for an out-of-process child frame.
export function monitorPluginViews(app, contents, onFailure) {
  const frames = new Map();
  contents.on('frame-created', (_event, { frame }) => {
    frame.on('dom-ready', () => {
      try {
        const url = new URL(frame.url);
        if (url.protocol === 'desk-plugin:') {
          frames.set(frame, { id: url.hostname, pid: frame.osProcessId });
          // Chromium omits parent focus events between child frames; every plugin gets the same host-owned notification.
          frame.executeJavaScript(`
            (() => {
              const activate = () => window.parent.postMessage({ type: 'desk:focus' }, 'desk-host://desktop');
              window.addEventListener('pointerdown', activate, true);
              window.addEventListener('focus', activate);
            })();
          `).catch((error) => console.error('[plugin:view-focus]', { pluginId: url.hostname, message: error.message }));
        }
      } catch {
        frames.delete(frame);
      }
    });
  });
  const timer = setInterval(() => {
    if (contents.isDestroyed()) {
      return;
    }
    const live = new Set(app.getAppMetrics().map((process) => process.pid));
    const mainFrame = contents.mainFrame;
    // A live webContents can retain a disposed frame while its renderer is being replaced.
    if (mainFrame.isDestroyed() || mainFrame.detached) {
      return;
    }
    const attached = mainFrame.framesInSubtree;
    for (const [frame, { id, pid }] of frames) {
      if (!attached.includes(frame)) {
        frames.delete(frame);
      } else if (!live.has(pid)) {
        frames.delete(frame);
        onFailure(id, { code: 'PLUGIN_VIEW_CRASHED', message: `插件 ${id} 的界面已退出，请重新打开` });
      }
    }
  }, 500);
  timer.unref();
  contents.once('destroyed', () => clearInterval(timer));
}
