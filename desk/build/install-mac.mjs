import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanApplicationEntries } from '../src/main/os/mac/installation.js';

const run = promisify(execFile);
const source = resolve('desk/dist/releases.noindex/mac-arm64/DeckPg.app');
const installed = '/Applications/DeckPg.app';
const staging = '/Applications/.DeckPg-installing.app';
const { stdout } = await run('/bin/ps', ['-axo', 'command']);
if (stdout.split('\n').some(line => line.trim().startsWith(`${installed}/Contents/MacOS/DeckPg`))) {
  throw Error('请先退出 DeckPg，再安装更新；不会强制结束任务。');
}
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
const backup = await mkdtemp(join(tmpdir(), 'deckpg-install-'));
const previous = join(backup, 'DeckPg.app.noindex');
// Replace only the application bundle; configuration, installed plugins and history remain in Application Support.
await mkdir(staging);
await run('/usr/bin/ditto', [source, staging]);
// A fresh installation has no previous bundle to back up or restore.
const hasPrevious = await rename(installed, previous).then(() => true).catch(error => {
  if (error.code === 'ENOENT') {
    return false;
  }
  throw error;
});
try {
  await rename(staging, installed);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
  await cleanApplicationEntries();
} catch (error) {
  await rm(installed, { recursive: true, force: true });
  if (hasPrevious) {
    await rename(previous, installed);
  }
  throw error;
}
await rm(backup, { recursive: true, force: true });
console.info('[install:complete]', { installed });
