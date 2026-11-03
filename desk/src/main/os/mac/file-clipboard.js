import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Publish native file references understood by Finder and other apps.
export function createFileClipboard() {
  const evaluate = async (script, args = []) => {
    const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args],
      { timeout: 5000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  };
  return {
    write: paths => evaluate(`ObjC.import('AppKit');
      function run(argv) {
        var board = $.NSPasteboard.generalPasteboard;
        board.clearContents;
        if (!board.setPropertyListForType($(JSON.parse(argv[0])), $.NSFilenamesPboardType)) { throw Error('无法复制文件'); }
      }`, [JSON.stringify(paths)]),
    // Read modern URL items and legacy Finder lists without treating plain text as a file.
    read: async () => JSON.parse(await evaluate(`ObjC.import('AppKit');
      var board = $.NSPasteboard.generalPasteboard;
      var urls = board.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $({}));
      var paths = [];
      for (var i = 0; urls && i < Number(ObjC.unwrap(urls.count)); i++) {
        var url = urls.objectAtIndex(i);
        if (url.isFileURL) { paths.push(ObjC.unwrap(url.path)); }
      }
      var files = board.propertyListForType($.NSFilenamesPboardType);
      var legacy = ObjC.deepUnwrap(files) || [];
      JSON.stringify(paths.length >= legacy.length ? paths : legacy);`))
  };
}
