import { fail } from '../../shared/contracts.js';

// Old API 2 packages retain their existing startup behavior until explicitly upgraded.
export function pluginProperties(manifest) {
  const properties = { type: 'application', showIcon: true, loadOnStartup: true, background: 'service', ...manifest };
  const { type, showIcon, loadOnStartup, background, main, views = [] } = properties;
  if (!['application', 'service', 'resource'].includes(type) || typeof showIcon !== 'boolean'
    || typeof loadOnStartup !== 'boolean' || !['none', 'task', 'service'].includes(background)) {
    throw fail('INVALID_PACKAGE', '插件需要有效的 type/showIcon/loadOnStartup/background 属性');
  }
  if (!Array.isArray(views) || views.some(view => !view || typeof view.id !== 'string' || !view.id
    || typeof view.title !== 'string' || !view.title || typeof view.entry !== 'string')
    || new Set(views.map(view => view.id)).size !== views.length) {
    throw fail('INVALID_PACKAGE', '插件 views 需要唯一的 id、title 和相对 entry');
  }
  if ((type !== 'application' && (showIcon || views.length))
    || (type === 'resource' && background !== 'none') || (background === 'task' && loadOnStartup)
    || (background === 'none' ? main !== undefined : typeof main !== 'string')) {
    throw fail('INVALID_PACKAGE', '插件类型、入口和后台方式不兼容；task 只能按需运行，none 不能声明 main');
  }
  return properties;
}
