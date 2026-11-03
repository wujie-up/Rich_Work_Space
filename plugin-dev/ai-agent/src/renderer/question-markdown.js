import { marked } from 'marked';
import DOMPurify from 'dompurify';

const renderer = new marked.Renderer();
// Model text is document content, never executable HTML or automatically fetched media.
const escape = text => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
renderer.html = token => escape(token.text);
renderer.image = token => escape(token.text || '图片');

export function renderQuestionMarkdown(node, question) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(question, { renderer, breaks: false }), {
    FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'style'],
    FORBID_ATTR: ['style']
  });
  for (const link of node.querySelectorAll('a')) {
    if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) {
      link.removeAttribute('href');
      continue;
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}
