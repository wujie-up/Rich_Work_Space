export function mountTerminalRenderer(terminal, session, browser, createRenderer) {
  // iOS WebViews can accept terminal writes without painting the WebGL canvas; keep their DOM renderer.
  const appleTouch = /iPhone|iPad|iPod/.test(browser.userAgent)
    || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
  if (appleTouch) {
    console.info('[session:renderer]', { sessionId: session.id, renderer: 'dom', reason: 'apple-touch' });
    return () => {};
  }
  // Desktop TUI redraws should not rebuild hundreds of DOM spans on every scroll frame.
  const renderer = createRenderer();
  const contextLoss = renderer.onContextLoss(() => {
    console.info('[session:renderer-fallback]', { sessionId: session.id, reason: 'context-lost' });
    renderer.dispose();
  });
  try {
    terminal.loadAddon(renderer);
  } catch (error) {
    renderer.dispose();
    console.error('[session:renderer-fallback]', { sessionId: session.id, error: error.stack });
  }
  return () => contextLoss.dispose();
}
