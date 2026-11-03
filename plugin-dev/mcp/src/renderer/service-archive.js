import { ZipReader, BlobReader } from '@zip.js/zip.js/lib/zip-core-native.js';

const MiB = 1024 * 1024;
const invalid = message => Object.assign(Error(message), { code: 'MCP_ARCHIVE_INVALID' });
const ignored = new Set(['.DS_Store', '__MACOSX', '.git', '.venv', '__pycache__', '.env']);

function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('/') || /^[a-z]:/i.test(value)
    || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw invalid('压缩包包含无效或越界路径');
  }
  return value;
}

function text(bytes) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\0')) {
      throw Error('Binary content');
    }
    return value;
  } catch {
    throw invalid('服务文件仅支持 UTF-8 文本');
  }
}

function json(bytes, label) {
  try {
    return JSON.parse(text(bytes));
  } catch {
    throw invalid(`${label}不是有效的 JSON`);
  }
}

function declaration(bytes, paths) {
  const value = json(bytes, '服务清单');
  if (!value || typeof value.name !== 'string' || !value.name.trim() || !['python', 'javascript'].includes(value.language)) {
    throw invalid('服务清单需要名称及 Python / JavaScript 语言声明');
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) {
    throw invalid('服务清单的功能描述须为最多 2000 字符的文本');
  }
  const entry = safePath(value.entry);
  const extension = entry.match(/\.[^/.]+$/)?.[0];
  if (!(value.language === 'python' ? ['.py'] : ['.js', '.mjs', '.cjs']).includes(extension) || !paths.has(entry)) {
    throw invalid('服务入口不存在或后缀与语言不匹配');
  }
  const fields = value.fields ?? [];
  if (!Array.isArray(fields) || fields.length > 64 || new Set(fields.map(field => field?.name)).size !== fields.length
    || fields.some(field => !field || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)
      || typeof field.label !== 'string' || !field.label.trim()
      || (field.secret !== undefined && typeof field.secret !== 'boolean')
      || (field.required !== undefined && typeof field.required !== 'boolean'))) {
    throw invalid('服务配置字段需要唯一环境变量名、标签和有效的 secret/required 声明');
  }
  return { name: value.name.trim(), description: value.description?.trim() || '', language: value.language, entry,
    fields: fields.map(({ name, label, secret = false, required = false }) => ({ name, label, secret, required })) };
}

async function readEntry(entry) {
  const chunks = [];
  let size = 0;
  // Bound actual output too: declared ZIP sizes are untrusted before extraction completes.
  await entry.getData(new WritableStream({ write(chunk) {
    size += chunk.byteLength;
    if (size > 4 * MiB) {
      throw invalid('单个服务文件最多 4 MiB');
    }
    chunks.push(chunk);
  } }), { useWebWorkers: false, checkCrc32: true, checkOverlappingEntry: true });
  if (size !== entry.uncompressedSize) {
    throw invalid('ZIP 文件大小与声明不一致，压缩包可能损坏');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function verifyIntegrity(files) {
  const inventory = files.get('integrity.json');
  if (!inventory) {
    return;
  }
  const value = json(inventory, '完整性清单');
  const names = [...files.keys()].filter(name => name !== 'integrity.json').sort();
  if (value?.algorithm !== 'sha256' || !value.files || Array.isArray(value.files)
    || JSON.stringify(Object.keys(value.files).sort()) !== JSON.stringify(names)) {
    throw invalid('服务完整性清单与包内文件不匹配');
  }
  for (const name of names) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', files.get(name)));
    const actual = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (value.files[name] !== actual) {
      throw invalid('服务完整性校验失败：文件内容已更改');
    }
  }
}

export async function readServiceArchive(file) {
  if (!file || !/\.zip$/i.test(file.name) || file.size > 20 * MiB) {
    throw invalid('请选择不超过 20 MiB 的 ZIP 服务压缩包');
  }
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false, strictness: 'strict' });
  try {
    const entries = [];
    const unique = new Set();
    let count = 0;
    let size = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > 4000) {
        throw invalid('服务压缩包最多 2000 个文件及 2000 个目录');
      }
      const name = safePath(entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename);
      const kind = (entry.unixMode || 0) & 0o170000;
      if (entry.symlink || (kind && ![0o100000, 0o040000].includes(kind))) {
        throw invalid('服务压缩包不能包含链接或特殊文件类型');
      }
      if (entry.encrypted) {
        throw invalid('不支持加密的服务压缩包');
      }
      if (entry.directory || name.split('/').some(part => ignored.has(part))) {
        continue;
      }
      const key = name.normalize('NFC').toLowerCase();
      if (unique.has(key)) {
        throw invalid('服务文件重复或存在大小写冲突');
      }
      unique.add(key);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > 4 * MiB) {
        throw invalid('单个服务文件最多 4 MiB');
      }
      size += entry.uncompressedSize;
      if (size > 16 * MiB || entries.length >= 2000) {
        throw invalid('服务压缩包最多 16 MiB、2000 个文件');
      }
      entries.push({ name, entry });
    }
    for (const name of unique) {
      const parents = name.split('/');
      parents.pop();
      while (parents.length) {
        if (unique.has(parents.join('/'))) {
          throw invalid('服务文件与目录路径冲突');
        }
        parents.pop();
      }
    }
    const manifests = entries.filter(({ name }) => name === 'mcp-service.json' || name.endsWith('/mcp-service.json'));
    if (manifests.length !== 1) {
      throw invalid('压缩包必须包含且仅包含一份 mcp-service.json 服务清单');
    }
    const manifest = manifests[0].name;
    const prefix = manifest.slice(0, -'mcp-service.json'.length);
    if (prefix.split('/').length > 2 || entries.some(({ name }) => !name.startsWith(prefix))) {
      throw invalid('服务清单须位于压缩包根目录或唯一的外层目录中');
    }
    const files = new Map();
    for (const { name, entry } of entries) {
      files.set(name.slice(prefix.length), await readEntry(entry));
    }
    await verifyIntegrity(files);
    const value = declaration(files.get('mcp-service.json'), new Set(files.keys()));
    const imported = [...files].map(([path, bytes]) => ({ path, content: text(bytes) }));
    return { ...value, transport: 'script', interpreter: '',
      env: Object.fromEntries(value.fields.map(field => [field.name, ''])), files: imported,
      source: imported.find(file => file.path === value.entry).content };
  } catch (error) {
    if (error.code === 'MCP_ARCHIVE_INVALID') {
      throw error;
    }
    throw invalid('ZIP 压缩包无效、损坏或包含不支持的压缩格式');
  } finally {
    await reader.close();
  }
}
