import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fail, pluginId } from '../../shared/contracts.js';

export class PluginIcons {
  constructor(storage, plugins) { Object.assign(this, { storage, plugins }); }

  async set(id, source) {
    this.plugins.record(pluginId(id));
    const extension = extname(source).toLowerCase();
    const content = await readFile(source);
    if (content.length > 512 * 1024 || !['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extension)) {
      throw fail('INVALID_ICON', '请选择 512 KB 以内的 PNG、JPEG、WebP 或 SVG 图标');
    }
    if (extension === '.svg') {
      const svg = content.toString('utf8');
      const tags = [...svg.matchAll(/<\/?([\w:-]+)/g)].map(match => match[1]);
      if (!svg.includes('<svg') || tags.some(tag => !['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'title', 'desc'].includes(tag))
        || /\bon\w+\s*=|href\s*=|url\s*\(|<!|<\?|style\s*=/i.test(svg)) {
        throw fail('INVALID_ICON', 'SVG 只能包含静态图形，不能包含脚本、外部引用或样式');
      }
    } else if (!(extension === '.png' && content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      && !(['.jpg', '.jpeg'].includes(extension) && content[0] === 255 && content[1] === 216)
      && !(extension === '.webp' && content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP')) {
      throw fail('INVALID_ICON', '图标文件内容与格式不符');
    }
    const key = `plugin-icons/${id}/icon${extension}`;
    await this.storage.replace(key, content);
    const icons = await this.storage.readJson('plugin-icons/index.json', {});
    icons[id] = { key, revision: Date.now() };
    await this.storage.writeJson('plugin-icons/index.json', icons);
    this.plugins.emit('plugins.changed', this.plugins.list());
  }

  async reset(id) {
    this.plugins.record(pluginId(id));
    const icons = await this.storage.readJson('plugin-icons/index.json', {});
    delete icons[id];
    await this.storage.writeJson('plugin-icons/index.json', icons);
    this.plugins.emit('plugins.changed', this.plugins.list());
  }

  async path(id) {
    const record = this.plugins.record(pluginId(id));
    if (record.state === 'uninstalled') { throw fail('PLUGIN_NOT_FOUND', '插件已卸载'); }
    const icons = await this.storage.readJson('plugin-icons/index.json', {});
    if (icons[id]) { return this.storage.path(icons[id].key); }
    return this.storage.path(`${(await this.storage.packageDirectory(id)).slice(this.storage.root.length + 1)}/ico/icon.svg`);
  }
}
