import { net } from 'electron';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginId } from '../../shared/contracts.js';

// Unique plugin origins allow Chromium site isolation to separate plugin renderers from the desktop.
export function registerPluginProtocol(protocol, storage, plugins) {
  protocol.handle('desk-plugin', async (request) => {
    try {
      const url = new URL(request.url);
      const id = pluginId(url.hostname);
      plugins.assertEnabled(id);
      const directory = await storage.path(`packages/${id}`);
      const path = resolve(directory, `.${decodeURIComponent(url.pathname)}`);
      const subpath = relative(directory, path);
      if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) {
        return new Response('Forbidden', { status: 403 });
      }
      await storage.path(join(`packages/${id}`, subpath));
      return await net.fetch(pathToFileURL(path).href);
    } catch (error) {
      console.error('[plugin:resource]', { url: request.url, message: error.message });
      return new Response('Plugin resource unavailable', { status: 404 });
    }
  });
}

export function registerDesktopProtocol(protocol, directory) {
  protocol.handle('desk-host', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'desktop' || !['/index.html', '/app.js', '/app.css'].includes(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(join(directory, url.pathname.slice(1))).href);
  });
}
