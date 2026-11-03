import { basename, posix } from 'node:path';

// Read only literal project metadata; never resolve entities or execute Maven during discovery.
function pomMetadata(xml) {
  const stack = [];
  const modules = [];
  let name = '';
  let module = '';
  for (const token of xml.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith('<') && !token.startsWith('<![CDATA[')) {
      if (token.startsWith('<!') || token.startsWith('<?')) {
        continue;
      }
      if (token.startsWith('</')) {
        if (stack.join('/') === 'project/modules/module') {
          modules.push(module.trim());
          module = '';
        }
        stack.pop();
      } else if (!token.endsWith('/>')) {
        stack.push(token.slice(1).split(/[\s>]/)[0].split(':').at(-1));
      }
      continue;
    }
    const text = (token.startsWith('<![CDATA[') ? token.slice(9, -3) : token)
      .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
    if (stack.join('/') === 'project/artifactId') {
      name += text;
    }
    if (stack.join('/') === 'project/modules/module') {
      module += text;
    }
  }
  return { name: name.trim(), modules };
}

function modulePath(parent, module) {
  const path = posix.normalize(posix.join(parent, module)).replace(/(^|\/)pom\.xml$/, '').replace(/\/$/, '');
  return path === '.' ? '' : path;
}

// Module declarations define the tree, including modules outside their aggregator's directory.
function projectHierarchy(projects) {
  const nodes = new Map(projects.map(project => [project.path, { path: project.path, name: project.name, parentPath: null }]));
  for (const project of projects) {
    for (const module of project.modules) {
      const child = nodes.get(modulePath(project.path, module));
      if (!module || !child || child.parentPath !== null) {
        continue;
      }
      let ancestor = nodes.get(project.path);
      while (ancestor && ancestor !== child) {
        ancestor = nodes.get(ancestor.parentPath);
      }
      if (!ancestor) {
        child.parentPath = project.path;
      }
    }
  }
  // A root POM owns its declared reactor; unrelated POMs are not additional directory rows.
  return [...nodes.values()].filter(node => {
    if (!nodes.has('')) {
      return true;
    }
    let root = node;
    while (root.parentPath !== null) {
      root = nodes.get(root.parentPath);
    }
    return root.path === '';
  });
}

export async function mavenProjects(workspace, signal) {
  const pending = [''];
  const projects = [];
  const scanned = new Set();
  const deadline = Date.now() + 10000;
  let visited = 0;
  let truncated = false;
  while (pending.length) {
    signal?.throwIfAborted();
    const path = pending.pop();
    if (scanned.has(path)) {
      continue;
    }
    if (visited >= 10000 || projects.length >= 200 || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    scanned.add(path);
    const result = await workspace.list({ path });
    visited += result.entries.length;
    if (result.entries.some(entry => entry.name === 'pom.xml' && !entry.directory)) {
      const metadata = pomMetadata(await workspace.text(posix.join(path, 'pom.xml')));
      projects.push({ path, name: metadata.name && !metadata.name.includes('${') ? metadata.name
        : path ? basename(path) : basename(workspace.root), modules: metadata.modules });
      // Once a POM is found, follow its reactor instead of traversing thousands of source files.
      pending.push(...metadata.modules.filter(Boolean).map(module => modulePath(path, module)).reverse());
    } else {
      pending.push(...result.entries.filter(entry => entry.directory).map(entry => entry.path).reverse());
    }
    if (result.truncated) {
      truncated = true;
      break;
    }
  }
  return { projects: projectHierarchy(projects), truncated };
}
