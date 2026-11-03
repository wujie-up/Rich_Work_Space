import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createFileClipboard as linuxClipboard } from '../src/main/os/linux/file-clipboard.js';
import { createFileClipboard as macClipboard } from '../src/main/os/mac/file-clipboard.js';

const execute = promisify(execFile);

test('Linux clipboard exchanges native file URI lists and ignores plain text', async () => {
  let bytes = Buffer.alloc(0);
  const files = linuxClipboard({ writeBuffer: (type, value) => { assert.equal(type, 'text/uri-list'); bytes = value; },
    readBuffer: () => bytes });
  const paths = ['/tmp/中文 a.txt', '/tmp/line\nname.md'];
  await files.write(paths);
  assert.deepEqual(await files.read(), paths);
  bytes = Buffer.from('# comment\r\nhttps://example.com\r\n');
  assert.deepEqual(await files.read(), []);
});

test('macOS clipboard exchanges native file URLs with Cocoa and restores prior clipboard', { skip: process.platform !== 'darwin' }, async t => {
  const run = async (script, args = []) => (await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args])).stdout.trim();
  // Preserve all eagerly available formats; this test never consumes a user's copied files.
  const previous = await run(`ObjC.import('AppKit'); var p = $.NSPasteboard.generalPasteboard;
    JSON.stringify(ObjC.deepUnwrap(p.types).map(function(type) {
      var data = p.dataForType($(type)); return [type, data ? ObjC.unwrap(data.base64EncodedStringWithOptions(0)) : null];
    }));`);
  t.after(() => run(`ObjC.import('AppKit'); function run(argv) {
    var p = $.NSPasteboard.generalPasteboard; p.clearContents;
    JSON.parse(argv[0]).forEach(function(item) { if (item[1] !== null) {
      p.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions($(item[1]), 0), $(item[0]));
    } });
  }`, [previous]));
  const root = await mkdtemp(join(tmpdir(), 'deckpg-native-clipboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, '中文 a.md'), join(root, 'second.txt')];
  await Promise.all(paths.map(path => writeFile(path, 'retained')));
  const files = macClipboard();
  await files.write(paths);
  assert.deepEqual(await files.read(), paths);
  const external = await run(`ObjC.import('AppKit');
    JSON.stringify(ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.propertyListForType($.NSFilenamesPboardType)));`);
  assert.deepEqual(JSON.parse(external), paths);
  await run(`ObjC.import('AppKit'); function run(argv) {
    var p = $.NSPasteboard.generalPasteboard; p.clearContents;
    p.setPropertyListForType($(JSON.parse(argv[0])), $.NSFilenamesPboardType);
  }`, [JSON.stringify(paths.slice(1))]);
  assert.deepEqual(await files.read(), paths.slice(1));
  // Keep the modern pasteboard owner alive, as Finder is during a real paste.
  const writer = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); function run(argv) {
    var p = $.NSPasteboard.generalPasteboard; p.clearContents;
    var urls = $.NSMutableArray.alloc.init;
    JSON.parse(argv[0]).forEach(function(path) { urls.addObject($.NSURL.fileURLWithPath(path)); });
    p.writeObjects(urls);
    console.log('ready');
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(3));
  }`, JSON.stringify(paths)]);
  t.after(() => writer.kill());
  await new Promise((resolve, reject) => {
    writer.stderr.once('data', resolve);
    writer.once('error', reject);
    writer.once('exit', code => reject(new Error(`Native clipboard writer exited: ${code}`)));
  });
  assert.deepEqual(await files.read(), paths);
  writer.kill();
  await run(`ObjC.import('AppKit'); var p = $.NSPasteboard.generalPasteboard;
    p.clearContents; p.setStringForType($('https://example.com/path'), $('public.utf8-plain-text'));`);
  assert.deepEqual(await files.read(), []);
});
