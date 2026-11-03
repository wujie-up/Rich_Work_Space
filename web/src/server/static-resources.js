import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { httpError, cacheableResource } from './http.js';

const digest = value => createHash('sha256').update(value).digest('hex');
// A missing or mismatched assistant build always keeps the ordinary network document.
export async function shellDocument(directory, version) {
  if (!/^[a-f0-9]{64}$/.test(version || '')) {
    return null;
  }
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'shell-manifest.json'), 'utf8'));
    if (manifest.version !== version || digest(JSON.stringify(manifest.files)) !== version) {
      return null;
    }
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    return html.replace(/<html(?=[\s>])/, `<html data-work-desk-shell="${version}"`)
      .replace(/<link rel="stylesheet" href="app.css">/, '')
      .replace(/<script type="module" src="app.js"><\/script>/, '');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[web:shell-resource]', { version, stack: error.stack });
    }
    return null;
  }
}

// The installed package inventory, rather than its human version label, owns cache identity.
export async function pluginResources(directory, browserVersion = '') {
  let inventory = null;
  try {
    inventory = JSON.parse(await readFile(join(directory, 'integrity.json'), 'utf8'));
    if (inventory.algorithm !== 'sha256' || !inventory.files || typeof inventory.files !== 'object') {
      throw Error('Invalid package resource inventory');
    }
  } catch (error) {
    inventory = null;
    if (error.code !== 'ENOENT') {
      console.error('[web:plugin-resources]', { pluginId: basename(directory), stack: error.stack });
    }
  }
  const entries = inventory && Object.keys(inventory.files).sort().map(name => [name, inventory.files[name]]);
  const version = inventory ? digest(JSON.stringify(browserVersion ? [entries, browserVersion] : entries)) : null;
  return {
    version,
    entry: path => version && Object.hasOwn(inventory.files, path) ? `__assets/${version}/${path}` : path,
    resolve: path => {
      if (!path.startsWith('/__assets/')) {
        return { pathname: path, cache: false };
      }
      let decoded;
      try {
        decoded = decodeURIComponent(path.slice(`/__assets/${version}/`.length));
      } catch {
        throw httpError(404, '资源不存在');
      }
      if (!version || !path.startsWith(`/__assets/${version}/`) || decoded.includes('\\') || decoded.includes('\0')
        || decoded.split('/').some(part => !part || part === '.' || part === '..') || !Object.hasOwn(inventory.files, decoded)) {
        throw httpError(404, '资源不存在');
      }
      return { pathname: '/' + path.slice(`/__assets/${version}/`.length), cache: cacheableResource(decoded) };
    }
  };
}

export async function pluginInputResources(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'plugin-input-manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(manifest.version) || digest(JSON.stringify(manifest.files)) !== manifest.version
    || Object.keys(manifest.files).sort().join(',') !== 'plugin-input.css,plugin-input.js') {
    throw Error('Invalid Web input resource inventory');
  }
  const prefix = `/_web_input/${manifest.version}/`;
  return {
    version: manifest.version,
    resolve: path => {
      if (!path.startsWith(prefix) || !Object.hasOwn(manifest.files, path.slice(prefix.length))) {
        throw httpError(404, '资源不存在');
      }
      return '/' + path.slice(prefix.length);
    },
    transform: (data, extension) => {
      if (extension !== '.html') {
        return data;
      }
      const tags = `<link rel="stylesheet" href="${prefix}plugin-input.css"><script type="module" src="${prefix}plugin-input.js"></script>`;
      const html = data.toString('utf8');
      return Buffer.from(/<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, tags + '$&')
        : html.replace(/^(<!doctype[^>]*>\s*)?/i, '$&' + tags));
    }
  };
}
