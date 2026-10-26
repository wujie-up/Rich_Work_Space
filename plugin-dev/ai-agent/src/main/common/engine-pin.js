// Release digest is published by the official openai/codex GitHub release assets API.
export const ENGINE_PIN = Object.freeze({
  runtimeId: 'codex-0.164.0-aarch64-apple-darwin', version: '0.164.0', platform: 'darwin-arm64', entry: 'bin/codex',
  url: 'https://github.com/openai/codex/releases/download/rust-v0.164.0/codex-package-aarch64-apple-darwin.tar.gz',
  source: 'https://api.github.com/repos/openai/codex/releases/assets/667983476',
  sha256: 'dd99e9092270691a67bdde7be04ac283dea9da8e86cbde356c2cc851a79205fa',
  downloadBytes: 136007998, requiredBytes: 650000000
});

export const CLAUDE_PIN = {
  runtimeId: 'claude-2.1.310-darwin-arm64', version: '2.1.310', platform: 'darwin-arm64', entry: 'bin/claude', format: 'binary',
  url: 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.310/darwin-arm64/claude',
  source: 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.310/manifest.json',
  sha256: 'ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd',
  downloadBytes: 274068224, requiredBytes: 900000000
};
