import { PluginIcons } from './plugin-icons.js';
import { net } from 'electron';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginId } from '../../shared/contracts.js';

// Unique plugin origins allow Chromium site isolation to separate plugin renderers from the desktop.
export function registerPluginProtocol(protocol, storage, plugins) {
  protocol.handle('desk-plugin', async (request) => {
    try {
      const url = new URL(request.url);
      const key = pluginId(url.hostname);
      plugins.assertEnabled(key);
      const directory = await storage.packageDirectory(key);
      const path = resolve(directory, `.${decodeURIComponent(url.pathname)}`);
      const subpath = relative(directory, path);
      if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) {
        return new Response('Forbidden', { status: 403 });
      }
      await storage.path(join(relative(storage.root, directory), subpath));
      return await net.fetch(pathToFileURL(path).href);
    } catch (error) {
      console.error('[plugin:resource]', { url: request.url, message: error.message });
      return new Response('Plugin resource unavailable', { status: 404 });
    }
  });
}

export function registerDesktopProtocol(protocol, directory, storage, plugins) {
  protocol.handle('desk-host', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'desktop' && /^\/plugin-icons\/[a-z0-9-]+$/.test(url.pathname) && storage && plugins) {
      try { return await net.fetch(pathToFileURL(await new PluginIcons(storage, plugins).path(url.pathname.split('/').pop())).href); }
      catch { return new Response('Not found', { status: 404 }); }
    }
    if (url.hostname !== 'desktop' || !['/index.html', '/app.js', '/app.css'].includes(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(join(directory, url.pathname.slice(1))).href);
  });
}
