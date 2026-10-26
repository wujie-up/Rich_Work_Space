import { isAbsolute, join } from 'node:path';

// Only an explicit isolated test run may bypass the production profile and installation.
export function startupProfile(appData, args) {
  const requested = args.find(arg => arg.startsWith('--desk-data='))?.slice(12);
  const testing = args.includes('--desk-test') && Boolean(requested) && isAbsolute(requested);
  return { directory: testing ? requested : join(appData, 'Work Desk'), testing };
}
