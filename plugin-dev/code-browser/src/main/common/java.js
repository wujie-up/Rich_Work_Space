import { tokenize } from './syntax.js';
import { fail } from './workspace.js';

const identifier = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;
const typeKeywords = new Set(['class', 'interface', 'enum', 'record']);

// Annotation arguments may contain assignments and braces; exclude them before interpreting class members.
function declarationTokens(source) {
  const tokens = tokenize(source).filter(token => !['comment', 'string'].includes(token.kind) && token.text.trim());
  const result = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== '@' || tokens[index + 1]?.text === 'interface') {
      result.push(tokens[index]);
      continue;
    }
    index++;
    while (tokens[index + 1]?.text === '.' && identifier.test(tokens[index + 2]?.text || '')) {
      index += 2;
    }
    if (tokens[index + 1]?.text === '(') {
      let depth = 0;
      do {
        index++;
        depth += tokens[index].text === '(' ? 1 : tokens[index].text === ')' ? -1 : 0;
      } while (index + 1 < tokens.length && depth > 0);
    }
  }
  return result;
}

function declarations(source, name, path) {
  const tokens = declarationTokens(source);
  const lines = source.split("\n");
  const scopes = [];
  const found = [];
  let pendingType;
  let line = 1;
  let offset = 0;
  const add = (token, kind) => {
    while (offset < token.offset) {
      if (source[offset++] === '\n') {
        line++;
      }
    }
    found.push({ name, kind, path, line, text: lines[line - 1].trim().slice(0, 240) });
  };
  for (let index = 0; index < tokens.length && found.length < 100; index++) {
    const token = tokens[index];
    const value = token.text;
    const scope = scopes.at(-1);
    if (typeKeywords.has(value) && tokens[index - 1]?.text !== '.' && identifier.test(tokens[index + 1]?.text || '')) {
      pendingType = tokens[index + 1].text;
      if (pendingType === name) {
        add(tokens[index + 1], 'class');
      }
    }
    if (value === '{') {
      scopes.push({ type: pendingType, start: index + 1 });
      pendingType = undefined;
    } else if (value === '}') {
      scopes.pop();
      if (scopes.length) {
        scopes.at(-1).start = index + 1;
      }
    } else if (value === ';' && scope) {
      scope.start = index + 1;
    } else if (value === name && tokens[index + 1]?.text === '(' && scope?.type && !pendingType) {
      const prefix = tokens.slice(scope.start, index).map(item => item.text);
      const previous = tokens[index - 1]?.text;
      // A class-level signature must have a return type (or be a constructor), never an initializer or member call.
      if (prefix.some(item => ['=', 'new', 'return', 'throw', '->'].includes(item)) || previous === '.'
        || (!identifier.test(previous || '') && ![']', '>'].includes(previous) && name !== scope.type)
        || (!prefix.length && name !== scope.type)) {
        continue;
      }
      let end = index + 1;
      let depth = 0;
      do {
        depth += tokens[end].text === '(' ? 1 : tokens[end].text === ')' ? -1 : 0;
        end++;
      } while (end < tokens.length && depth > 0);
      if (tokens[end]?.text === 'throws') {
        while (end < tokens.length && !['{', ';', '}'].includes(tokens[end].text)) {
          end++;
        }
      }
      if (['{', ';'].includes(tokens[end]?.text)) {
        add(token, 'method');
      }
    }
  }
  return found;
}

/** Scan current source each time so Maven output or external edits cannot leave a stale symbol index. */
export async function definitions(workspace, { name }, signal) {
  if (typeof name !== 'string' || name.length > 128 || !identifier.test(name)) {
    throw fail('INVALID_SYMBOL', '请输入 Java 类或方法标识符（最长 128 字符）');
  }
  const candidates = [];
  const pending = [''];
  const deadline = Date.now() + 10000;
  let scanned = 0;
  const limited = reason => ({ candidates: candidates.slice(0, 100), scanned, truncated: true, reason });
  while (pending.length) {
    signal?.throwIfAborted();
    const listing = await workspace.list({ path: pending.pop() });
    if (listing.truncated) {
      return limited('目录条目超出上限，请选择更小的项目');
    }
    for (const entry of listing.entries) {
      signal?.throwIfAborted();
      if (++scanned > 10000 || Date.now() >= deadline) {
        return limited('达到扫描条目或时间上限，请选择更小的项目');
      }
      if (entry.directory) {
        pending.push(entry.path);
        continue;
      }
      if (!entry.name.endsWith('.java')) {
        continue;
      }
      let source;
      try {
        source = await workspace.text(entry.path);
      } catch (error) {
        if (!['NOT_TEXT', 'FILE_LIMIT', 'ENOENT', 'EACCES'].includes(error.code)) {
          throw error;
        }
        continue;
      }
      candidates.push(...declarations(source, name, entry.path));
      if (candidates.length >= 100) {
        return limited('达到 100 个定义候选上限');
      }
    }
  }
  return { candidates, scanned, truncated: false };
}
