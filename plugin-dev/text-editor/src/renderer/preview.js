import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escape } from './bridge.js';

let mermaidEngine;
let plantEngine;
let diagramId = 0;
const script = name => new Promise((resolve, reject) => {
  const element = document.createElement('script');
  element.src = new URL(`./plantuml/${name}.js`, location.href).href;
  element.onload = resolve;
  element.onerror = () => reject(Error(`无法加载离线资源 ${name}`));
  document.head.append(element);
});

async function plantuml(source, dark) {
  // External/local includes and URL expansion are deliberately outside this offline preview contract.
  if (/!\s*(include\w*|import\w*|theme\b[^\n]*\bfrom\b)|%\s*(load\w*|getenv|filename|dirpath)\s*\(|https?:\/\//i.test(source)) {
    throw Error('离线预览不支持外部 include、文件读取或网络资源');
  }
  plantEngine ||= (async () => {
    await script('viz-global');
    await script('themes');
    await script('openiconic');
    await script('emoji');
    const path = './plantuml/plantuml.js';
    return import(path);
  })().catch(error => { plantEngine = null; throw error; });
  const engine = await plantEngine;
  const lines = source.includes('@start') ? source : `@startuml\n${source}\n@enduml`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('PlantUML 渲染超时，请简化图形')), 15000);
    engine.renderToString(lines.split(/\r?\n/), svg => { clearTimeout(timer); resolve(svg); },
      error => { clearTimeout(timer); reject(Error(String(error))); }, { dark, maxSvgSize: 4096 });
  });
}

async function diagram(language, source) {
  if (source.length > 20000) { throw Error('单个绘图代码超过 20,000 字符'); }
  const dark = document.documentElement.dataset.theme === 'dark';
  if (language === 'plantuml' || language === 'puml') { return plantuml(source, dark); }
  mermaidEngine ||= (async () => {
    const path = './mermaid.js';
    return (await import(path)).default;
  })().catch(error => { mermaidEngine = null; throw error; });
  const engine = await mermaidEngine;
  engine.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
    maxTextSize: 20000, suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false } });
  return (await engine.render(`diagram-${++diagramId}`, source)).svg;
}

export async function renderPreview(container, text, type, current = () => true) {
  const diagrams = [];
  const renderer = new marked.Renderer();
  renderer.html = token => escape(token.text);
  renderer.image = token => escape(token.text || '图片');
  renderer.code = token => {
    const language = (token.lang || '').trim().toLowerCase();
    if (!['mermaid', 'plantuml', 'puml'].includes(language)) { return `<pre><code>${escape(token.text)}</code></pre>`; }
    const index = diagrams.push({ language, source: token.text }) - 1;
    return `<figure data-diagram="${index}"><figcaption>${escape(language)} · 渲染中…</figcaption></figure>`;
  };
  const markdown = ['puml', 'plantuml'].includes(type) ? `\`\`\`plantuml\n${text}\n\`\`\`` : text;
  const html = DOMPurify.sanitize(marked.parse(markdown, { renderer, breaks: false }), {
    FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'style', 'img'], FORBID_ATTR: ['style']
  });
  if (!current()) { return; }
  container.innerHTML = html;
  container.querySelectorAll('a').forEach(link => { link.removeAttribute('href'); });
  // Sequential rendering avoids races in shared diagram engines and keeps source order stable.
  for (const [index, entry] of diagrams.entries()) {
    if (!current()) { return; }
    const target = container.querySelector(`[data-diagram="${index}"]`);
    try {
      const svg = await diagram(entry.language, entry.source);
      if (!current()) { return; }
      target.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'image', 'a'], FORBID_ATTR: ['href', 'xlink:href'] });
      target.dataset.rendered = entry.language;
    } catch (error) {
      if (!current()) { return; }
      target.textContent = `${entry.language}：${error.message}`;
      target.classList.add('diagram-error');
    }
  }
}
