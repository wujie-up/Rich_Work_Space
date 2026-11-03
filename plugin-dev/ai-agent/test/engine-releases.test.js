import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineReleases } from '../src/main/common/engine-releases.js';

test('Codex metadata failures expose a concise error and retain diagnostic details only in logs', async t => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const failure of [
    Error('Command failed: /usr/bin/curl --proxy http://127.0.0.1:7897 --output /private/tmp/metadata\ncurl: (56) The requested URL returned error: 403'),
    Error('Command failed: /usr/bin/curl\ncurl: (28) Operation timed out')
  ]) {
    const releases = new EngineReleases({ platform: 'darwin-arm64', json: async () => { throw failure; } });
    await assert.rejects(releases.list('codex'), error => {
      assert.match(error.message, /Codex.*版本.*失败/);
      assert.doesNotMatch(error.message, /curl|127\.0\.0\.1|\/private\/tmp/);
      if (failure.message.includes('403')) { assert.match(error.message, /HTTP 403/); }
      return true;
    });
    assert.ok(logs.mock.calls.some(call => call.arguments.some(argument => argument?.stack === failure.stack)));
  }
});

test('release discovery excludes prereleases and refuses official assets without trusted SHA-256', async () => {
  const releases = new EngineReleases({ platform: 'darwin-arm64', json: async () => ({ tag_name: 'rust-v1.0.0', assets: [{ name: 'codex-package-aarch64-apple-darwin.tar.gz', digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: 'https://github.com/openai/codex/releases/download/rust-v1.0.0/codex-package-aarch64-apple-darwin.tar.gz', size: 10 }] }) });
  const values = await releases.list('codex');
  assert.deepEqual(values.map(value => value.version), ['1.0.0']);
  await assert.rejects(releases.resolve('codex', '0.9.0'), /校验/);
});

test('untrusted or unstable Codex metadata cannot become an installation candidate', async () => {
  const asset = { name: 'codex-package-aarch64-apple-darwin.tar.gz', digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: 'https://github.com/openai/codex/releases/download/rust-v1.0.0/codex-package-aarch64-apple-darwin.tar.gz' };
  for (const release of [
    { prerelease: true, assets: [asset] }, { draft: true, assets: [asset] },
    { assets: [{ ...asset, digest: null }] },
    { assets: [{ ...asset, browser_download_url: 'https://example.com/untrusted.tar.gz' }] }
  ]) {
    const releases = new EngineReleases({ platform: 'darwin-arm64', json: async () => ({ tag_name: 'rust-v1.0.0', ...release }) });
    assert.deepEqual(await releases.list('codex'), []);
  }
});

test('Claude channels deduplicate and require platform checksums before installation', async () => {
  const releases = new EngineReleases({ platform: 'darwin-arm64', text: async () => '2.1.311\n',
    json: async () => ({ platforms: { 'darwin-arm64': { checksum: 'b'.repeat(64) } } }) });
  const versions = await releases.list('claude');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, '2.1.311');
  assert.equal(versions[0].sha256, 'b'.repeat(64));
  releases.json = async () => ({ platforms: {} });
  await assert.rejects(releases.list('claude'), /SHA-256/);
  releases.text = async () => '../../invalid';
  await assert.rejects(releases.list('claude'), /版本号/);
});
