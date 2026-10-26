import { fail } from '../../shared/contracts.js';

export function validatePresentation(view) {
  const value = view.presentation;
  if (value === undefined) {
    return;
  }
  if (!value || value.type !== 'overlay' || ![
    ['width', 240, 800], ['height', 100, 800], ['collapsedWidth', 240, 800], ['collapsedHeight', 32, 64]
  ].every(([key, min, max]) => Number.isFinite(value[key]) && value[key] >= min && value[key] <= max)) {
    throw fail('INVALID_PACKAGE', '悬浮视图需要有效的 type 和有界尺寸');
  }
}

// Old API 2 packages retain their existing startup behavior until explicitly upgraded.
export function pluginProperties(manifest) {
  const properties = { type: 'application', showIcon: true, loadOnStartup: true, background: 'service', singleInstance: false, ...manifest };
  const { type, showIcon, loadOnStartup, background, main, views = [] } = properties;
  // Legacy development declarations remain readable; the removed preview API is no longer exposed.
  const features = ['desk.capabilities.v1', 'desk.entries.v1', 'desk.settings.v1', 'desk.development.v1',
    'desk.overlays.v1', 'desk.runtime-directory.v1'];
  if (properties.requiredHostFeatures !== undefined && (!Array.isArray(properties.requiredHostFeatures)
    || properties.requiredHostFeatures.some(feature => !features.includes(feature)))) {
    throw fail('INVALID_PACKAGE', '插件需要当前宿主不支持的协议，请先升级工作台');
  }
  if (typeof properties.singleInstance !== 'boolean') {
    throw fail('INVALID_PACKAGE', 'singleInstance 必须是布尔值');
  }
  if (properties.settings !== undefined && (!properties.settings || typeof properties.settings !== 'object'
    || Array.isArray(properties.settings) || typeof properties.settings.entry !== 'string' || !properties.settings.entry.trim())) {
    throw fail('INVALID_PACKAGE', 'settings 需要有效的相对 entry');
  }
  if (properties.author !== undefined && !(typeof properties.author === 'string'
    || (properties.author && !Array.isArray(properties.author) && typeof properties.author.name === 'string'))) {
    throw fail('INVALID_PACKAGE', 'author 必须是名称或包含 name 的对象');
  }
  if (properties.closeDescription !== undefined
    && (typeof properties.closeDescription !== 'string' || properties.closeDescription.length > 240)) {
    throw fail('INVALID_PACKAGE', 'closeDescription 必须是 240 字以内的关闭说明');
  }
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
  if (views.some(view => view.contributes !== undefined && (!Array.isArray(view.contributes?.entries)
    || view.contributes.entries.some(entry => typeof entry !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(entry))))) {
    throw fail('INVALID_PACKAGE', '插件视图入口必须是 64 字以内的小写字母、数字或连字符');
  }
  views.forEach(validatePresentation);
  return properties;
}
