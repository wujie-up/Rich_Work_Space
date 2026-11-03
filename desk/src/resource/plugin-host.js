// The native origin stays fixed; HTTPS plugins accept only their same-host workspace parent.
export function pluginHostOrigin(location = globalThis.location, referrer = globalThis.document?.referrer) {
  if (location?.protocol !== 'https:') {
    return 'desk-host://desktop';
  }
  const parent = new URL(referrer);
  if (parent.protocol !== 'https:' || parent.hostname !== location.hostname || parent.origin === location.origin) {
    throw Error('插件工作空间来源无效');
  }
  return parent.origin;
}

export function pluginIdentity(location = globalThis.location) {
  return location.protocol === 'https:' ? new URLSearchParams(location.search).get('deskPlugin') : location.hostname;
}
