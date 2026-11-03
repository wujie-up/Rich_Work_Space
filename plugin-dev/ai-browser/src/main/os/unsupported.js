export function createBrowserPlatform() {
  return {
    spawnTask: () => { throw Error('当前版本仅验证 macOS，无法在此平台安装内核'); },
    chromePath: async () => null,
    launch: async () => { throw Error('当前版本仅验证 macOS，请勿在此平台启动浏览器'); }
  };
}
