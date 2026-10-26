import { escape } from './api.js';

const defaults = [];
export function deploymentForm(value) {
  return `<div id="script">
<div class="row"><label>语言<select name="language"><option value="javascript">JavaScript</option><option value="python">Python</option></select></label>
<label>入口文件<input name="entry" value="${escape(value.entry || 'server.mjs')}"></label></div>
<label>服务代码<textarea name="source" spellcheck="false" placeholder="粘贴 Python 或 JavaScript MCP 服务代码">${escape(value.source || '')}</textarea></label>
<details><summary>运行与导入设置</summary>
<label>运行环境<input name="interpreter" placeholder="node / python3 / 虚拟环境解释器绝对路径" value="${escape(value.interpreter || '')}"></label>
<small>运行环境与依赖须预先准备；Python 可指定虚拟环境解释器。</small>
<div class="row"><label>导入脚本<input id="script-file" type="file" accept=".js,.mjs,.cjs,.py"></label>
<label>导入服务目录<input id="script-directory" type="file" webkitdirectory multiple></label></div>
<small id="import-summary">${value.deployment ? '已加载部署代码；修改入口时保留其他文件。' : '可导入文件或目录，也可直接填写代码。'}</small></details>
<details><summary>配置字段声明</summary><p>由服务提供方声明，配置值以环境变量形式传给服务。</p>
<textarea name="fields" spellcheck="false">${escape(JSON.stringify(value.fields || defaults, null, 2))}</textarea>
</details></div>`;
}

// Editing declarations must retain stored configuration even though parameter inputs are no longer displayed.
export function bindDeployment(form, value) {
  let files;
  let fields = value.fields || defaults;
  const applyFields = () => {
    const next = JSON.parse(form.elements.fields.value);
    if (!Array.isArray(next) || next.some(field => !field || typeof field.name !== 'string' || typeof field.label !== 'string')) {
      throw Error('字段声明必须是包含 name 和 label 的数组');
    }
    fields = next;
  };
  form.elements.language.value = value.language || 'javascript';
  form.elements.language.onchange = () => {
    form.elements.entry.value = form.elements.language.value === 'python' ? 'server.py' : 'server.mjs';
    form.elements.interpreter.value = '';
  };
  const importFiles = async event => {
    try {
      const selected = [...event.target.files];
      if (!selected.length) { return; }
      const previousLanguage = form.elements.language.value;
      const root = selected[0].webkitRelativePath?.split('/')[0];
      const imported = [];
      let size = 0;
      for (const file of selected) {
        const path = root ? file.webkitRelativePath.slice(root.length + 1) : file.name;
        // Runtime environments and credentials belong outside the portable service source directory.
        if (path.split('/').some(part => ['.git', '.venv', '__pycache__', '.DS_Store', '.env'].includes(part))) { continue; }
        size += file.size;
        if (file.size > 4 * 1024 * 1024 || size > 16 * 1024 * 1024 || imported.length >= 2000) { throw Error('导入超限：单文件 4 MiB、总计 16 MiB、最多 2000 个文件'); }
        const content = await file.text();
        if (content.includes('\0') || content.includes('\uFFFD')) { throw Error(`仅支持 UTF-8 文本文件：${path}`); }
        imported.push({ path, content });
      }
      const manifest = imported.find(file => file.path === 'mcp-service.json');
      if (manifest) {
        const declaration = JSON.parse(manifest.content);
        for (const key of ['name', 'language', 'entry']) {
          if (typeof declaration[key] === 'string') { form.elements[key].value = declaration[key]; }
        }
        form.elements.fields.value = JSON.stringify(declaration.fields || [], null, 2);
        applyFields();
      } else if (imported.length === 1) {
        form.elements.entry.value = imported[0].path;
        form.elements.language.value = imported[0].path.endsWith('.py') ? 'python' : 'javascript';
      }
      // A changed language cannot reuse an interpreter selected for the previous runtime.
      if (form.elements.language.value !== previousLanguage) { form.elements.interpreter.value = ''; }
      files = imported;
      form.elements.source.value = files.find(file => file.path === form.elements.entry.value)?.content || '';
      form.querySelector('#import-summary').textContent = `已选择 ${files.length} 个文件；保存后部署。`;
      document.querySelector('#status').textContent = '';
    } catch (error) {
      files = undefined;
      event.target.value = '';
      document.querySelector('#status').textContent = error.message;
    }
  };
  for (const id of ['script-file', 'script-directory']) { form.querySelector(`#${id}`).onchange = importFiles; }
  return () => {
    applyFields();
    const source = form.elements.source.value;
    return { language: form.elements.language.value, entry: form.elements.entry.value, interpreter: form.elements.interpreter.value,
      fields, env: { ...value.env }, deployment: value.deployment,
      ...(files ? { files } : {}),
      ...(!value.deployment || files || source !== value.source ? { source } : {}) };
  };
}
