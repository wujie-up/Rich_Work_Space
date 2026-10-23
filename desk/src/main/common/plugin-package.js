import { cp, lstat, readdir, readFile, mkdir, rename, rm, mkdtemp, copyFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { create, list, extract } from 'tar';
import { randomUUID } from 'node:crypto';
import { fail, pluginId } from '../../shared/contracts.js';
import { pluginProperties } from './plugin-manifest.js';

// Local packages are trusted code, but their files must remain inside their owned directory.
async function inspectFiles(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw fail('INVALID_PACKAGE', '插件包不能包含符号链接或特殊文件');
    }
    if (info.isDirectory()) {
      await inspectFiles(path);
    }
  }
}

export async function inspectPackage(source) {
  if (!(await lstat(source)).isDirectory()) {
    throw fail('INVALID_PACKAGE', '请选择插件目录');
  }
  await inspectFiles(source);
  const manifest = pluginProperties(JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')));
  pluginId(manifest.id);
  if (!manifest.name || !manifest.version || manifest.apiVersion !== 2 || manifest.dataVersion !== 1) {
    throw fail('INVALID_PACKAGE', '插件清单需要 name/version、apiVersion=2（旧版请保留数据后重新导入）、dataVersion=1');
  }
  for (const path of [manifest.main, ...(manifest.views || []).map(view => view.entry)].filter(path => path !== undefined)) {
    const entry = relative(resolve(source), resolve(source, path));
    if (isAbsolute(path) || !entry || entry.startsWith('..')
      || !await lstat(join(source, entry)).then(info => info.isFile(), () => false)) {
      throw fail('INVALID_PACKAGE', '插件入口越界或不存在');
    }
  }
  return manifest;
}

async function importDirectory(storage, source) {
  const manifest = await inspectPackage(source);
  const staging = await storage.path(`packages/.staging-${randomUUID()}`);
  const target = await storage.path(`packages/${manifest.id}`);
  await mkdir(await storage.path('packages'), { recursive: true, mode: 0o700 });
  try {
    await cp(source, staging, { recursive: true, dereference: false });
    await inspectPackage(staging);
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}

// Inspect a private snapshot first so an archive cannot change between validation and extraction.
export async function withPackageSource(source, action) {
  if ((await lstat(source)).isDirectory()) {
    return action(source);
  }
  if (!source.endsWith('.plg')) {
    throw fail('INVALID_PACKAGE', '请选择 .plg 插件包');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'work-desk-package-'));
  try {
    const archive = join(temporary, 'package.plg');
    const directory = join(temporary, 'content');
    await copyFile(source, archive);
    await mkdir(directory);
    let invalid;
    let size = 0;
    let count = 0;
    await list({ file: archive, strict: true, onReadEntry: (entry) => {
      const path = entry.path;
      size += entry.size;
      count += 1;
      if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes('\\') || path.split('/').includes('..')) {
        invalid = '插件包路径越界';
      } else if (!['File', 'Directory'].includes(entry.type)) {
        invalid = '插件包不能包含链接或特殊文件';
      } else if (size > 512 * 1024 * 1024 || count > 10000) {
        invalid = '插件包超过 512 MiB 或 10000 个条目限制';
      }
    } });
    if (invalid) {
      throw fail('INVALID_PACKAGE', invalid);
    }
    await extract({ file: archive, cwd: directory, strict: true, noChmod: true });
    await inspectPackage(directory);
    return await action(directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function importPackage(storage, source) {
  return withPackageSource(source, (directory) => importDirectory(storage, directory));
}

// The extension identifies Work Desk packages; the payload remains a standard gzip tar archive.
export async function packPackage(source, target) {
  const manifest = await inspectPackage(source);
  if (!target.endsWith('.plg') || !relative(resolve(source), resolve(target)).startsWith('..')) {
    throw fail('INVALID_PACKAGE', '输出必须是插件目录外的 .plg 文件');
  }
  await mkdir(resolve(target, '..'), { recursive: true });
  await create({ file: target, cwd: source, gzip: true, portable: true }, await readdir(source));
  console.info('[plugin:pack]', { pluginId: manifest.id, target });
  return manifest;
}
