import { executablePath } from '../posix/environment.js';

export { stopOwnedProcess } from '../posix/process-control.js';
export const managedPlatform = 'darwin-' + process.arch;
export { downloadEngine, engineNetworkEnvironment } from './download.js';
export { readLocalCredential } from './credentials.js';
export function engineExecutablePath() {
  return executablePath(['/opt/homebrew/bin', '/opt/homebrew/sbin']);
}
