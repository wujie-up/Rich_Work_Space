import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import { addresses, certificate } from '../src/server/certificate.js';

test('Web certificate explicitly permits TLS servers and is reused while valid', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wd-certificate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await certificate(directory);
  assert.ok(new X509Certificate(first.cert).keyUsage?.includes('1.3.6.1.5.5.7.3.1'));
  assert.deepEqual(await certificate(directory), first);
});

test('cached certificates missing serverAuth are replaced without changing other data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wd-certificate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = await generate([{ name: 'commonName', value: 'legacy workspace' }], {
    algorithm: 'sha256', keySize: 2048,
    extensions: [{ name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'subjectAltName', altNames: addresses().map(value => value === 'localhost'
        ? { type: 2, value } : { type: 7, ip: value }) }]
  });
  await writeFile(join(directory, 'certificate.pem'), old.cert);
  await writeFile(join(directory, 'private-key.pem'), old.private);
  await writeFile(join(directory, 'unrelated-data'), 'preserved');
  const current = await certificate(directory);
  assert.notEqual(current.cert, old.cert);
  assert.ok(new X509Certificate(current.cert).keyUsage?.includes('1.3.6.1.5.5.7.3.1'));
  assert.equal(await readFile(join(directory, 'unrelated-data'), 'utf8'), 'preserved');
});
