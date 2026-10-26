const platforms = { darwin: './mac/index.js', linux: './linux/index.js' };
if (!platforms[process.platform]) {
  throw Error(`AI Agent 暂不支持的操作系统：${process.platform}`);
}
export const { stopOwnedProcess, managedPlatform, downloadEngine, engineNetworkEnvironment, readLocalCredential } = await import(platforms[process.platform]);
