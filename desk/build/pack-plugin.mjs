import { resolve, join } from 'node:path';
import { inspectPackage, packPackage } from '../src/main/common/plugin-package.js';

const source = process.argv[2];
if (!source) {
  throw Error('用法：npm run pack:plugin -- <插件目录> [输出.plg]（先运行 npm run build）');
}
const directory = resolve(source);
const manifest = await inspectPackage(directory);
const target = resolve(process.argv[3] || join('plugin-dev/dist', `${manifest.id}-${manifest.version}.plg`));
await packPackage(directory, target);
