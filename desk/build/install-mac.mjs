import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanApplicationEntries } from '../src/main/os/mac/installation.js';

const run = promisify(execFile);
const source = resolve('desk/dist/releases.noindex/mac-arm64/DeskPG.app');
const installed = '/Applications/DeskPG.app';
const staging = '/Applications/.DeskPG-installing.app';
// Accept the previous brand name so updating does not leave a second application bundle.
let previousInstallation = installed;
try {
  await access(installed);
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
  previousInstallation = '/Applications/DeckPg.app';
}
const { stdout } = await run('/bin/ps', ['-axo', 'command']);
if (stdout.split('\n').some(line => [installed, previousInstallation].some(path => line.trim().toLowerCase().startsWith(`${path}/Contents/MacOS/`.toLowerCase())))) {
  throw Error('请先退出 DeskPG，再安装更新；不会强制结束任务。');
}
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
const backup = await mkdtemp(join(tmpdir(), 'deskpg-install-'));
const previous = join(backup, 'DeskPG.app.noindex');
// Replace only the application bundle; configuration, installed plugins and history remain in Application Support.
await mkdir(staging);
await run('/usr/bin/ditto', [source, staging]);
// A fresh installation has no previous bundle to back up or restore.
const hasPrevious = await rename(previousInstallation, previous).then(() => true).catch(error => {
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
    await rename(previous, previousInstallation);
  }
  throw error;
}
await rm(backup, { recursive: true, force: true });
console.info('[install:complete]', { installed });
