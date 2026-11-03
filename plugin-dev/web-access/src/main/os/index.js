import { macPlatform } from './mac/index.js';

export function createPlatform(context) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw Error('当前版本仅提供 macOS Apple Silicon 传输引擎');
  }
  return macPlatform(context);
}
