import { cleanApplicationEntries } from '../src/main/os/mac/installation.js';

// Used after packaging and as a standalone installation check; neither path opens the build app.
export default async function checkInstallation() {
  await cleanApplicationEntries();
}

if (process.argv[1]?.endsWith('/check-mac-installation.mjs')) {
  await checkInstallation();
}
