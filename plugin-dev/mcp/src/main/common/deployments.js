import { mkdir, writeFile, rename, rm, lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';

const invalid = message => Object.assign(Error(message), { code: 'INVALID_ARGUMENT' });
const languages = { python: { command: 'python3', extensions: ['.py'] }, javascript: { command: 'node', extensions: ['.js', '.mjs', '.cjs'] } };

function filePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(value)) {
    throw invalid('服务文件路径无效或越界');
  }
  return value;
}

// Copy uploaded text only; do not execute manifests or package installation hooks during import.
function validateFiles(files, entry) {
  if (!Array.isArray(files) || !files.length || files.length > 2000) { throw invalid('请导入服务文件，最多 2000 个'); }
  const paths = new Set();
  let total = 0;
  for (const file of files) {
    filePath(file.path);
    if (paths.has(file.path) || typeof file.content !== 'string') { throw invalid('服务文件重复或内容无效'); }
    paths.add(file.path);
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > 4 * 1024 * 1024 || total > 16 * 1024 * 1024) { throw invalid('服务文件过大：单文件最多 4 MiB，总计最多 16 MiB'); }
  }
  if (!paths.has(entry)) { throw invalid('入口文件不在导入目录中'); }
}

function configuration(input) {
  if (!languages[input.language]) { throw invalid('本地服务仅支持 Python 和 JavaScript'); }
  const entry = filePath(input.entry);
  if (!languages[input.language].extensions.includes(posix.extname(entry))) { throw invalid('入口文件后缀与语言不匹配'); }
  const fields = input.fields || [];
  if (!Array.isArray(fields) || fields.length > 64 || new Set(fields.map(field => field?.name)).size !== fields.length
    || fields.some(field => !field || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) || typeof field.label !== 'string'
      || !field.label.trim() || (field.secret !== undefined && typeof field.secret !== 'boolean')
      || (field.required !== undefined && typeof field.required !== 'boolean'))) {
    throw invalid('配置字段需要唯一的环境变量名、标签，以及布尔类型的 secret/required');
  }
  if (input.interpreter !== undefined && (typeof input.interpreter !== 'string' || input.interpreter.includes('\0'))) {
    throw invalid('运行环境必须是可执行文件路径或命令名');
  }
  const env = input.env || {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')
    || fields.some(field => field.required && !env[field.name]?.trim())) { throw invalid('请填写所有必填配置，值必须是字符串'); }
  return { language: input.language, entry, interpreter: input.interpreter?.trim() || languages[input.language].command,
    fields: fields.map(({ name, label, secret = false, required = false }) => ({ name, label, secret, required })), env };
}

export class Deployments {
  constructor(context) { this.context = context; }

  async directory(id, revision) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !/^[a-f0-9-]{36}$/.test(revision)) { throw invalid('服务部署标识无效'); }
    return this.context.storage.path(`plugin-data/${this.context.pluginId}/deployments/${id}/${revision}`);
  }

  async save(input, existing) {
    const config = configuration(input);
    let files = input.files;
    if (input.source !== undefined) {
      if (typeof input.source !== 'string' || !input.source.trim()) { throw invalid('服务代码不能为空'); }
      // An entry edit must retain imported helpers and manifests from its owned revision.
      files ||= existing?.deployment ? await this.files(existing) : [];
      files = [...files.filter(file => file.path !== config.entry), { path: config.entry, content: input.source }];
    }
    if (!files) {
      // Only references already owned by this definition may be reused by configuration-only edits.
      if (!existing?.deployment || input.deployment !== existing.deployment) { throw invalid('请先导入服务代码'); }
      const files = await this.files(existing);
      const info = files.find(file => file.path === config.entry);
      if (!info) { throw invalid('入口不在所属部署中'); }
      return { ...config, deployment: existing.deployment };
    }
    validateFiles(files, config.entry);
    const revision = randomUUID();
    const target = await this.directory(input.id, revision);
    const staging = `${target}.tmp`;
    try {
      for (const file of files) {
        const path = join(staging, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.content, { mode: 0o600 });
      }
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { ...config, deployment: revision };
  }

  async files(config) {
    const root = await this.directory(config.id, config.deployment);
    const files = [];
    let total = 0;
    const visit = async (directory, prefix = '') => {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) { throw invalid('部署目录不能包含符号链接'); }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        // Python creates binary caches after launch; they are not part of imported editable source.
        if (entry.name === '__pycache__' || /\.py[co]$/.test(entry.name)) { continue; }
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(full, path);
        } else {
          const info = await lstat(full);
          total += info.size;
          if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024
            || total > 16 * 1024 * 1024 || files.length >= 2000) { throw invalid('部署包含非普通文件或超过导入限制'); }
          files.push({ path, content: await readFile(full, 'utf8') });
        }
      }
    };
    await visit(root);
    return files;
  }

  async source(config) {
    return (await this.files(config)).find(file => file.path === config.entry)?.content ?? '';
  }

  async remove(config) {
    await rm(await this.directory(config.id, config.deployment), { recursive: true, force: true });
  }

  async launch(config) {
    const cwd = await this.directory(config.id, config.deployment);
    return { ...config, transport: 'stdio', command: config.interpreter, args: [config.entry], cwd };
  }
}
