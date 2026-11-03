export { stopOwnedProcess } from '../posix/process-control.js';
export { executablePath as engineExecutablePath } from '../posix/environment.js';
export const managedPlatform = 'linux-' + process.arch;
export { downloadEngine } from './download.js';
export async function readLocalCredential() { return null; }

export async function engineNetworkEnvironment() { return {}; }
