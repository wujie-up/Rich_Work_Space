// Only a clipboard consisting entirely of paths becomes attachments; prose remains native terminal input.
export function clipboardPaths(text, type = 'text/plain') {
  const lines = text.trim().split(/\r?\n/).filter(line => line && (type !== 'text/uri-list' || !line.startsWith('#')));
  const paths = lines.map(line => {
    let path = line.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\([\s\\'"()])/g, '$1');
    if (path.startsWith('file:')) {
      try {
        const url = new URL(path);
        path = url.protocol === 'file:' && !url.host ? decodeURIComponent(url.pathname) : '';
      } catch {
        path = '';
      }
    }
    return /^(?:\/|~\/|\.\.?\/)/.test(path) && !/[\x00-\x1f\x7f]/.test(path) ? path : null;
  });
  return paths.every(Boolean) ? paths : [];
}
