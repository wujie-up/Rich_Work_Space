import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadEngine, managedPlatform } from '../os/index.js';
import { ENGINE_PIN, CLAUDE_PIN } from './engine-pin.js';

const claudeRoot = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';
const versionPattern = /^\d+\.\d+\.\d+$/;
const digestPattern = /^[a-f0-9]{64}$/;

async function officialText(url) {
  const directory = await mkdtemp(join(tmpdir(), 'work-desk-releases-'));
  try {
    const file = join(directory, 'metadata');
    await downloadEngine(url, file, { timeoutSeconds: 12 });
    return await readFile(file, 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Only official platform-specific artifacts with a published SHA-256 can become installation candidates.
export class EngineReleases {
  constructor(options = {}) {
    this.platform = options.platform || managedPlatform;
    this.text = options.text || officialText;
    this.json = options.json || (async url => JSON.parse(await this.text(url)));
  }

  async list(id) {
    if (this.platform !== 'darwin-arm64') { throw Error('当前在线引擎仅支持已验证的 macOS Apple Silicon'); }
    if (id === 'codex') {
      let releases;
      try {
        releases = [await this.json('https://api.github.com/repos/openai/codex/releases/latest')];
      } catch (error) {
        console.error('[ai:release-check-error]', { pluginId: 'ai-agent-sessions', engineId: id, stack: error.stack });
        // Process errors contain command arguments and local paths; keep them out of the settings response.
        const status = (error.stderr || error.message).match(/returned error: (\d{3})/)?.[1];
        throw Error(`Codex 官方版本检查失败${status ? `（HTTP ${status}）` : ''}，请稍后重试`);
      }
      return releases.filter(release => !release.draft && !release.prerelease && versionPattern.test(release.tag_name?.replace(/^rust-v/, '')))
        .flatMap(release => {
          const asset = release.assets.find(asset => asset.name === 'codex-package-aarch64-apple-darwin.tar.gz');
          const sha256 = asset?.digest?.replace(/^sha256:/, '');
          if (!digestPattern.test(sha256 || '')) { return []; }
          const version = release.tag_name.replace(/^rust-v/, '');
          const url = `https://github.com/openai/codex/releases/download/rust-v${version}/${asset.name}`;
          if (asset.browser_download_url !== url) { return []; }
          return [{ ...ENGINE_PIN, version, runtimeId: `codex-${version}-aarch64-apple-darwin`, url,
            source: 'https://api.github.com/repos/openai/codex/releases', sha256, downloadBytes: asset.size }];
        });
    }
    if (id !== 'claude') { throw Error('不支持的引擎'); }
    const versions = [...new Set(await Promise.all(['latest', 'stable'].map(async channel => (await this.text(`${claudeRoot}/${channel}`)).trim())))];
    return Promise.all(versions.map(version => this.claude(version)));
  }

  async claude(version) {
    if (!versionPattern.test(version)) { throw Error('官方版本号无效'); }
    const source = `${claudeRoot}/${version}/manifest.json`;
    const manifest = await this.json(source);
    const checksum = manifest.platforms?.[this.platform]?.checksum;
    if (!digestPattern.test(checksum || '')) { throw Error('官方未提供可验证的 SHA-256'); }
    return { ...CLAUDE_PIN, version, runtimeId: `claude-${version}-${this.platform}`, source,
      url: `${claudeRoot}/${version}/${this.platform}/claude`, sha256: checksum };
  }

  async resolve(id, version) {
    if (!versionPattern.test(version)) { throw Error('版本号无效'); }
    const release = (await this.list(id)).find(release => release.version === version);
    if (!release) { throw Error('版本不在官方可校验列表中，请刷新列表后重试'); }
    return release;
  }
}
