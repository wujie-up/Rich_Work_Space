export function createBrowserPlatform() {
  return { launch: async () => { throw Error('网页登录目前仅验证了 macOS，请使用已验证的平台或 OpenAPI 方式'); } };
}
