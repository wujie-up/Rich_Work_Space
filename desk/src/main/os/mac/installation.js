import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const installed = '/Applications/DeckPg.app';
const identifier = 'local.workdesk.desktop';

// Launch Services and Spotlight feed separate app lists; checking only registration misses indexed build copies.
function applicationPaths(dump) {
  return [...new Set(dump.split(/\n-+\n/).filter(block =>
    block.match(/^identifier:\s+(.+)$/m)?.[1].trim() === identifier)
    .map(block => block.match(/^path:\s+(.+?) \(0x/m)?.[1]).filter(Boolean))];
}

// Remove only this bundle ID's extra launch entries; application bundles and saved data are never deleted.
export async function cleanApplicationEntries(run = promisify(execFile)) {
  const invoke = async (command, args) => run(command, args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  const { stdout } = await invoke(register, ['-dump']);
  const duplicates = applicationPaths(stdout).filter(path => path !== installed);
  for (const path of duplicates) {
    await invoke(register, ['-u', path]);
  }
  await invoke(register, ['-f', installed]);
  const remaining = applicationPaths((await invoke(register, ['-dump'])).stdout);
  const indexed = (await invoke('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${identifier}"`])).stdout.trim()
    .split('\n').filter(Boolean);
  if (remaining.length !== 1 || remaining[0] !== installed) {
    throw Error(`DeckPg Launch Services 入口异常：${remaining.join(', ')}`);
  }
  if (indexed.some(path => path !== installed)) {
    throw Error(`DeckPg Spotlight 存在重复入口：${indexed.filter(path => path !== installed).join(', ')}`);
  }
  console.info('[host:installation-entries]', { bundleId: identifier, installed, removed: duplicates.length, indexed: indexed.length });
}
