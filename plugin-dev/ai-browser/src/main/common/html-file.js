import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve on the backend so relative Agent output uses the session's working directory, not the plugin directory.
export async function localHtmlUrl({ path, cwd }) {
  if (typeof path !== 'string' || !/\.html?$/i.test(path)) {
    throw Error('请选择本地 HTML 文件');
  }
  if (!isAbsolute(path) && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw Error('相对 HTML 路径需要绝对工作目录');
  }
  const file = await realpath(isAbsolute(path) ? path : resolve(cwd, path));
  if (!['.html', '.htm'].includes(extname(file).toLowerCase()) || !(await stat(file)).isFile()) {
    throw Error('只能预览本地 HTML 文件');
  }
  return pathToFileURL(file).href;
}
