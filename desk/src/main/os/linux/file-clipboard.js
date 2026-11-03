import { fileURLToPath, pathToFileURL } from 'node:url';

// File managers exchange copied files as URI lists rather than plain path text.
export function createFileClipboard(clipboard) {
  return {
    write: paths => clipboard.writeBuffer('text/uri-list', Buffer.from(paths.map(path => pathToFileURL(path).href).join('\r\n'))),
    read: async () => clipboard.readBuffer('text/uri-list').toString().split(/\r?\n/)
      .filter(line => line.startsWith('file:')).map(line => fileURLToPath(line))
  };
}
