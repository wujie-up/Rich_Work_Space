import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import bash from 'highlight.js/lib/languages/bash';

Object.entries({ sql, json, markdown, yaml, xml, javascript, typescript, css, python, java, bash })
  .forEach(([name, grammar]) => hljs.registerLanguage(name, grammar));
hljs.registerAliases('jsonc', { languageName: 'json' });

// Parsing stays off the input thread, and only escaped library markup is returned to the view.
self.onmessage = ({ data }) => {
  let html = null;
  try {
    const extension = data.name.split('.').pop().toLowerCase();
    const language = hljs.getLanguage(extension) ? extension : data.type;
    if (hljs.getLanguage(language)) {
      html = hljs.highlight(data.text, { language, ignoreIllegals: true }).value;
    }
  } catch (error) {
    console.error('[text-editor:syntax]', { pluginId: 'text-editor', documentId: data.documentId, name: data.name }, error);
    html = null;
  }
  self.postMessage({ generation: data.generation, html });
};
