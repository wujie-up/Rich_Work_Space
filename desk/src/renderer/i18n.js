import { translate } from '../shared/i18n.js';

export const t = (key, parameters) => translate(key, document.documentElement.lang, parameters);

// Only explicitly marked host nodes are updated; iframe documents and plugin metadata stay untouched.
export function message(node, value, attribute = 'textContent') {
  const descriptor = Array.isArray(value) ? value : [value];
  node.setAttribute(`data-i18n-${attribute.toLowerCase()}`, JSON.stringify(descriptor));
  const translated = t(...descriptor);
  if (attribute === 'textContent') {
    node.textContent = translated;
  } else {
    node.setAttribute(attribute, translated);
  }
}

export function setLanguage(language) {
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll('[data-i18n-textcontent], [data-i18n-title], [data-i18n-aria-label]')) {
    for (const attribute of ['textContent', 'title', 'aria-label']) {
      const descriptor = node.getAttribute(`data-i18n-${attribute.toLowerCase()}`);
      if (descriptor) {
        message(node, JSON.parse(descriptor), attribute);
      }
    }
  }
}
