// Providers declare formats; the desktop never needs a particular plugin ID.
export function fileProvider(plugins, name) {
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  const providers = plugins.filter(plugin => plugin.state === 'enabled' && !plugin.operation).flatMap(plugin => plugin.views
    .filter(view => view.contributes?.fileExtensions?.includes(extension)).map(view => ({ plugin, view })));
  if (providers.length > 1) {
    throw Error('该文件类型存在多个提供方，请保留一个启用的插件');
  }
  return providers[0];
}
