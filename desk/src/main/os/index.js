const platforms = { darwin: './mac/index.js', linux: './linux/index.js' };
if (!platforms[process.platform]) {
  throw Error(`暂不支持的操作系统：${process.platform}`);
}
const platform = await import(platforms[process.platform]);
export const { loadLoginPath, stopProcessGroups, windowOptions, hideOnClose } = platform;
