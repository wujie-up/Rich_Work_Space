import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { readServiceArchive } from '../src/renderer/service-archive.js';

const declaration = { name: '测试服务', description: '只读查询测试数据。', language: 'javascript', entry: 'server.mjs',
  fields: [{ name: 'PASSWORD', label: '密码', secret: true, required: true }] };
const encoder = new TextEncoder();

async function archive(entries, options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, content] of Object.entries(entries)) {
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    await writer.add(name, new Uint8ArrayReader(bytes), { level: 0, ...options });
  }
  return new File([await writer.close()], 'service.zip');
}

function files(change = {}) {
  return { 'mcp-service.json': JSON.stringify(declaration), 'server.mjs': 'export const secret = process.env.PASSWORD;', ...change };
}

test('generated Jenkins and feishu-doc ZIPs import from their enclosing folder with blank local configuration', async () => {
  for (const [name, entry] of [['mcp-jenkins-1.1.0.zip', 'server.mjs'], ['feishu-doc-1.0.0.zip', 'server.cjs']]) {
    const bytes = await readFile(new URL(`../../dist/${name}`, import.meta.url));
    const value = await readServiceArchive(new File([bytes], name));
    assert.equal(value.transport, 'script');
    assert.equal(value.language, 'javascript');
    assert.equal(value.entry, entry);
    assert.equal(value.files.length, 5);
    assert.equal(value.files.find(file => file.path === entry).content, value.source);
    assert.ok(Object.values(value.env).every(value => value === ''));
    assert.equal(value.interpreter, '');
    assert.equal(value.id, undefined);
  }
});

test('root manifest supports Python and helper files; command, credentials and runtime paths are never prefilled', async () => {
  const value = await readServiceArchive(await archive({
    'mcp-service.json': JSON.stringify({ ...declaration, language: 'python', entry: 'server.py',
      env: { PASSWORD: 'package-password' }, interpreter: '/untrusted/python', command: 'run-me' }),
    'server.py': 'from helpers.lib import value', 'helpers/lib.py': 'value = 1'
  }));
  assert.equal(value.entry, 'server.py');
  assert.equal(value.files.find(file => file.path === 'helpers/lib.py').content, 'value = 1');
  assert.deepEqual(value.env, { PASSWORD: '' });
  assert.equal(value.interpreter, '');
  assert.equal(value.command, undefined);
  assert.equal(value.description, declaration.description);
});

test('manifest, entry and configuration field declarations must describe one valid local service', async () => {
  for (const contents of [{ 'server.mjs': 'x' }, files({ 'mcp-service.json': '{broken' }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, entry: '../outside.mjs' }) }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, entry: 'missing.mjs' }) }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, language: 'shell' }) }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, language: 'python' }) }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, description: 123 }) }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, fields: [{ name: 'BAD-NAME', label: '字段' }] }) }),
    files({ 'mcp-service.json': JSON.stringify({ ...declaration, fields: [declaration.fields[0], declaration.fields[0]] }) }),
    { ...files(), 'other/mcp-service.json': JSON.stringify(declaration) }]) {
    await assert.rejects(readServiceArchive(await archive(contents)), /清单|入口|字段|服务|路径/);
  }
});

test('unsafe paths, links, encrypted entries, case collisions and binary sources are rejected before import', async () => {
  for (const filename of ['../escape.mjs', '/absolute.mjs', 'C:/drive.mjs', 'helper\\escape.mjs', 'a/../escape.mjs']) {
    await assert.rejects(readServiceArchive(await archive(files({ [filename]: 'x' }))), { code: 'MCP_ARCHIVE_INVALID' });
  }
  await assert.rejects(readServiceArchive(await archive(files(), { unixMode: 0o120777 })), /链接|类型/);
  await assert.rejects(readServiceArchive(await archive(files(), { password: 'secret' })), /加密/);
  await assert.rejects(readServiceArchive(await archive(files({ 'A.mjs': 'x', 'a.mjs': 'y' }))), /重复|冲突/);
  await assert.rejects(readServiceArchive(await archive(files({ 'helper': 'x', 'helper/lib.mjs': 'y' }))), /冲突/);
  await assert.rejects(readServiceArchive(await archive(files({ 'binary.bin': new Uint8Array([255, 0, 128]) }))), /UTF-8|文本/);
});

test('integrity inventory detects modified or extra files and accepts exact SHA-256 manifests', async () => {
  const contents = files();
  const hashes = Object.fromEntries(Object.entries(contents).map(([name, value]) =>
    [name, createHash('sha256').update(value).digest('hex')]));
  const inventory = JSON.stringify({ algorithm: 'sha256', files: hashes });
  assert.equal((await readServiceArchive(await archive({ ...contents, 'integrity.json': inventory }))).name, declaration.name);
  for (const changed of [{ 'server.mjs': 'tampered' }, { 'extra.mjs': 'unexpected' }]) {
    await assert.rejects(readServiceArchive(await archive({ ...contents, ...changed, 'integrity.json': inventory })), /完整性/);
  }
});

test('archive, file and total quotas reject oversized input and invalid ZIP data', async () => {
  await assert.rejects(readServiceArchive(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.zip')), /20 MiB/);
  await assert.rejects(readServiceArchive(new File(['not-zip'], 'broken.zip')), /ZIP|压缩包/);
  await assert.rejects(readServiceArchive(await archive(files({ 'huge.txt': 'x'.repeat(4 * 1024 * 1024 + 1) }))), /4 MiB/);
  const large = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`part${i}.txt`, 'x'.repeat(4 * 1024 * 1024)]));
  await assert.rejects(readServiceArchive(await archive({ ...files(), ...large })), /16 MiB/);
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`f${i}.mjs`, 'x']));
  await assert.rejects(readServiceArchive(await archive({ ...files(), ...many })), /2000/);
});

test('CRC detects damaged content even when the package has no integrity inventory', async () => {
  const file = await archive(files());
  const bytes = new Uint8Array(await file.arrayBuffer());
  const offset = Buffer.from(bytes).indexOf('export const secret');
  assert.ok(offset > 0);
  bytes[offset] ^= 1;
  await assert.rejects(readServiceArchive(new File([bytes], 'damaged.zip')), /ZIP|损坏/);
});

test('a similarly prefixed sibling cannot hide a file being used as a directory', async () => {
  await assert.rejects(readServiceArchive(await archive(files({
    helper: 'plain file', 'helper-extra': 'sibling', 'helper/lib.mjs': 'nested file'
  }))), /冲突/);
});
