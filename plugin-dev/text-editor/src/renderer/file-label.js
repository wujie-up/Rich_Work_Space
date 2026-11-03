import { escape } from './bridge.js';

const fileTypes = { md: 'md', txt: 'txt', json: 'json', xml: 'xml', yaml: 'yaml', puml: 'puml', log: 'log',
  markdown: 'md', jsonc: 'json', yml: 'yaml', plantuml: 'puml', html: 'xml', htm: 'xml',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', css: 'code', sh: 'code', py: 'code', sql: 'code' };

// Presentation never changes the path or the full name used by file operations and accessibility.
export function fileLabel(name, directory = false) {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
  const type = directory ? 'folder' : Object.hasOwn(fileTypes, extension) ? fileTypes[extension] : 'file';
  const label = !directory && extension ? name.slice(0, dot) : name;
  const abbreviation = type === 'file' || extension === 'jsonc' || extension.length > 5 ? type : extension;
  const icon = directory
    ? '<svg class="file-type-icon folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v12H3z"/></svg>'
    : `<svg class="file-type-icon" data-type="${escape(type)}" viewBox="0 0 40 22" aria-hidden="true"><rect x="1" y="1" width="38" height="20" rx="3"/><text x="20" y="15" text-anchor="middle">${escape(abbreviation.toUpperCase())}</text></svg>`;
  return `${icon}<span class="file-label">${escape(label)}</span>`;
}
