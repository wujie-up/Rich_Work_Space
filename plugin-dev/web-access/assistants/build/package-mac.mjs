import { execFileSync } from 'node:child_process';
import { mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { prepareResources } from './resources.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, '../plugin.json'), 'utf8'));
await prepareResources();
execFileSync('swift', ['build', '--package-path', root, '-c', 'release'], { stdio: 'inherit' });
const path = execFileSync('swift', ['build', '--package-path', root, '-c', 'release', '--show-bin-path'], { encoding: 'utf8' }).trim();
const bundle = join(root, '../dist/assistant/Work Desk Assistant.app');
await rm(bundle, { recursive: true, force: true });
await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
await mkdir(join(bundle, 'Contents/Resources'), { recursive: true });
await cp(join(path, 'DeskLink_DeskLinkClient.bundle'), join(bundle, 'Contents/Resources/DeskLink_DeskLinkClient.bundle'), { recursive: true });
await cp(join(path, 'DeskLinkMac'), join(bundle, 'Contents/MacOS/DeskLinkMac'));
await writeFile(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.work-desk.assistant</string>
<key>CFBundleName</key><string>DeskPG</string>
<key>CFBundleDisplayName</key><string>DeskPG</string>
<key>CFBundleExecutable</key><string>DeskLinkMac</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${manifest.version}</string>
<key>CFBundleVersion</key><string>${manifest.version}</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSLocalNetworkUsageDescription</key><string>通过加密连接访问您配对的工作台。</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'inherit' });
console.log(bundle);
