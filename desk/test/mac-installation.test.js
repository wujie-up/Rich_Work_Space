import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanApplicationEntries } from '../src/main/os/mac/installation.js';

const official = '/Applications/DeckPg.app';
const build = '/project/releases.noindex/mac-arm64/DeckPg.app';
const registration = (path, id = 'local.workdesk.desktop') => `----------------\npath: ${path} (0x4)\nidentifier: ${id}\n`;

test('installation removes only duplicate DeckPg registrations and verifies Spotlight too', async () => {
  const calls = [];
  let dumps = 0;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === '-dump') {
      return { stdout: registration(official) + (dumps++ === 0 ? registration(build) + registration('/Other.app', 'other.app') : '') };
    }
    return { stdout: command.endsWith('mdfind') ? `${official}\n` : '' };
  };
  await cleanApplicationEntries(run);
  assert.deepEqual(calls.filter(([, args]) => args[0] === '-u').map(([, args]) => args[1]), [build]);
  assert.ok(calls.some(([, args]) => args[0] === '-f' && args[1] === official));
  assert.ok(calls.some(([command]) => command.endsWith('mdfind')));
});

test('installation rejects duplicate Spotlight results rather than reporting successful cleanup', async () => {
  const run = async command => ({ stdout: command.endsWith('mdfind') ? `${official}\n${build}\n` : registration(official) });
  await assert.rejects(cleanApplicationEntries(run), /Spotlight.*releases.noindex/);
});
