import { tokenize } from '../main/common/syntax.js';

export function fileType(path) {
  const extension = path.split('.').at(-1).toLowerCase();
  return ['java', 'vue', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'xml', 'json'].includes(extension)
    ? extension : 'text';
}

const fileIcons = {
  json: 'braces', java: 'java', vue: 'vue', js: 'code', jsx: 'code', ts: 'code', tsx: 'code', html: 'code', xml: 'code',
  css: 'style', scss: 'style', less: 'style', md: 'markdown'
};

// Filename lookup only: icons never require opening files or loading external assets.
export function fileIcon(path) {
  const name = path.split('/').at(-1).toLowerCase();
  const extension = name.split('.').at(-1);
  return name === '.gitignore' ? 'ignore' : Object.hasOwn(fileIcons, extension) ? fileIcons[extension] : 'file';
}

/** Build text nodes only: source markup must never become executable HTML in the sandbox. */
export function sourceLines(file) {
  const lines = [];
  const createLine = () => {
    const line = document.createElement('span');
    line.className = 'source-line';
    line.dataset.line = file.startLine + lines.length;
    lines.push(line);
    return line;
  };
  let line = createLine();
  for (const token of tokenize(file.text, ['vue', 'html', 'xml'].includes(fileType(file.path)))) {
    token.text.split('\n').forEach((part, index) => {
      if (index) {
        line = createLine();
      }
      if (!part) {
        return;
      }
      const span = document.createElement('span');
      span.className = `syntax-${token.kind || 'plain'}`;
      span.textContent = part;
      if (file.path.endsWith('.java') && !file.revision && token.kind === 'identifier') {
        span.dataset.symbol = part;
        span.title = '双击查找项目内定义';
      }
      line.append(span);
    });
  }
  return file.text ? lines : [];
}
