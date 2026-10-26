import { format, applyEdits, parse } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import xmlFormat from 'xml-formatter';
import { XMLValidator } from 'fast-xml-parser';

export function formatText(text, type) {
  if (type === 'json' || type === 'jsonc') {
    const errors = [];
    parse(text, errors, { allowTrailingComma: type === 'jsonc', disallowComments: type === 'json' });
    if (errors.length) { throw Error(`JSON 格式错误，位置 ${errors[0].offset}`); }
    // Format source tokens rather than parsed numbers to retain large integer precision.
    return applyEdits(text, format(text, undefined, { insertSpaces: true, tabSize: 2, eol: '\n' }));
  }
  if (type === 'yaml' || type === 'yml') {
    // Formatting must retain numeric source precision rather than round through JavaScript Number.
    const document = parseDocument(text, { uniqueKeys: true, intAsBigInt: true,
      customTags: tags => tags.map(tag => tag.tag === 'tag:yaml.org,2002:float'
        ? { ...tag, stringify: node => node.source } : tag) });
    if (document.errors.length) { throw Error(document.errors[0].message); }
    return document.toString({ indent: 2 });
  }
  if (type === 'xml') {
    const validation = XMLValidator.validate(text);
    if (validation !== true) { throw Error(`XML 格式错误：${validation.err.msg}`); }
    return xmlFormat(text, { indentation: '  ', lineSeparator: '\n', collapseContent: true });
  }
  return text;
}
