import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export function addresses() {
  return ['localhost', '127.0.0.1', ...new Set(Object.values(networkInterfaces()).flat()
    .filter(value => value?.family === 'IPv4' && !value.internal).map(value => value.address))];
}

export async function certificate(directory) {
  const names = addresses();
  try {
    const cert = await readFile(join(directory, 'certificate.pem'), 'utf8');
    const key = await readFile(join(directory, 'private-key.pem'), 'utf8');
    const parsed = new X509Certificate(cert);
    // Apple TLS requires an explicit serverAuth purpose, including for a pinned self-signed anchor.
    if (parsed.keyUsage?.includes('1.3.6.1.5.5.7.3.1') && Date.parse(parsed.validTo) > Date.now() + 7 * 86400_000
      && names.every(name => name === 'localhost' ? parsed.checkHost(name) : parsed.checkIP(name))) {
      return { cert, key };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[web:certificate-read]', { stack: error.stack });
    }
  }
  const value = await generate([{ name: 'commonName', value: 'DeskPG local workspace' }], {
    algorithm: 'sha256', keySize: 2048,
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: names.map(value => value === 'localhost' ? { type: 2, value } : { type: 7, ip: value }) }]
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'private-key.pem'), value.private, { mode: 0o600 });
  await writeFile(join(directory, 'certificate.pem'), value.cert, { mode: 0o600 });
  console.info('[web:certificate-created]', { addresses: names });
  return { key: value.private, cert: value.cert };
}
