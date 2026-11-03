import { closePopup, showPopup } from '../../../../desk/src/resource/popup.js';
import { chooseDesktopFile, escape } from './api.js';
import { formatUserInputPrompt } from './user-input-prompt.js';
import { documentLinkAnswer } from './document-link.js';
import { formatReviewSections } from '../shared/review-sections.js';

// The dialog lives outside the result list so run events do not replace an unfinished answer.
export function createUserInputDialog({ invoke, onConfirmed }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'user-input-dialog';
  dialog.setAttribute('aria-labelledby', 'user-input-title');
  dialog.innerHTML = `<div data-input-form><h2 id="user-input-title"></h2><pre data-question id="user-input-question"></pre><div data-review-sections></div>
    <label data-text-input>补充内容<textarea rows="7" aria-describedby="user-input-question" placeholder="填写问题的答案或补充说明"></textarea></label>
    <div data-file-input hidden><div class="file-input-heading"><label for="user-input-file">选择文档</label>
    <button type="button" class="icon-button file-help" aria-label="支持的文档格式" aria-describedby="file-input-hint" title="支持的文档格式"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5 M12 17v.1"/></svg></button>
    <small id="file-input-hint" role="tooltip">支持 UTF-8 文本或 Markdown 文件，最大 2 MB。粘贴链接时直接将地址传给后续节点，不读取网页内容。Word / PDF 文件请先转换为文本。</small></div>
    <label class="file-source">文件来源<select aria-label="文件来源"><option value="system">系统文件</option><option value="desktop">工作台文件</option><option value="link">粘贴链接</option></select></label>
    <label data-link-input hidden>网页链接<input type="url" aria-label="网页链接" placeholder="https://example.com/document" autocomplete="off"></label>
    <input id="user-input-file" type="file" accept="text/*,.md,.markdown,.txt,.json,.yaml,.yml,.csv,.log,.xml">
    <button type="button" data-desktop-file hidden class="icon-button" title="选择工作台文件" aria-label="选择工作台文件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v13H3z M8 21h8 M12 17v4 M7 8h10 M7 12h6"/></svg></button>
    <span data-file-name></span></div>
    <fieldset data-choice-input hidden><legend>请选择一个选项</legend><div data-options></div></fieldset>
    <p role="alert" class="error-text" hidden></p><footer><button type="button" data-stop title="停止流程" aria-label="停止流程" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg></button>
    <span class="spacer"></span><button type="button" data-later title="稍后处理" aria-label="稍后处理" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5v14 M16 5v14"/></svg></button>
    <button type="button" data-confirm class="icon-button primary" title="确认并继续" aria-label="确认并继续"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l5 5L20 6"/></svg></button></footer></div>`;
  document.body.append(dialog);
  const form = dialog.querySelector('[data-input-form]');
  const answer = dialog.querySelector('textarea');
  const fileInput = dialog.querySelector('input[type="file"]');
  const fileSource = dialog.querySelector('.file-source select');
  const desktopButton = dialog.querySelector('[data-desktop-file]');
  const linkInput = dialog.querySelector('[data-link-input] input');
  const error = dialog.querySelector('[role="alert"]');
  let pending = null;
  let desktopFile = null;
  async function defer() {
    if (!pending || pending.required) { return; }
    try {
      onConfirmed(await invoke('runs.interrupt', pending.runId));
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
  }
  dialog.querySelector('[data-later]').onclick = defer;
  dialog.addEventListener('cancel', event => { event.preventDefault(); defer(); });
  fileInput.onchange = () => {
    dialog.querySelector('[data-file-name]').textContent = fileInput.files[0]?.name || '';
    error.hidden = true;
  };
  fileSource.onchange = () => {
    fileInput.value = '';
    desktopFile = null;
    linkInput.value = '';
    dialog.querySelector('[data-link-input]').hidden = fileSource.value !== 'link';
    fileInput.hidden = fileSource.value !== 'system';
    desktopButton.hidden = fileSource.value !== 'desktop';
    dialog.querySelector('[data-file-name]').textContent = '';
    error.hidden = true;
  };
  desktopButton.onclick = async () => {
    const request = pending;
    desktopButton.disabled = true;
    error.hidden = true;
    try {
      const selected = await chooseDesktopFile();
      // An old picker must not fill a question that was stopped or replaced while it was open.
      if (selected && pending === request && fileSource.value === 'desktop') {
        desktopFile = new File([selected.bytes], selected.name);
        dialog.querySelector('[data-file-name]').textContent = selected.name;
      }
    } catch (failure) {
      if (pending === request) {
        error.textContent = failure.message;
        error.hidden = false;
      }
    } finally {
      desktopButton.disabled = false;
    }
  };

  async function readAnswer(request) {
    if (request.form.interaction === 'file') {
      if (fileSource.value === 'link') {
        return documentLinkAnswer(linkInput.value);
      }
      const file = fileSource.value === 'desktop' ? desktopFile : fileInput.files[0];
      if (!file || file.size === 0 || file.size > 2 * 1024 * 1024) {
        throw Error('请选择不超过 2 MB 的文本需求文档');
      }
      if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(file.name)) {
        throw Error('Word / PDF 等二进制文档请先转换为 UTF-8 文本或 Markdown');
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw Error('请使用 UTF-8 文本或 Markdown 文档，Word / PDF 请先转换为文本');
      }
      if (text.includes('\0')) {
        throw Error('所选文件不是文本，Word / PDF 请先转换为文本');
      }
      if (!text.trim()) {
        throw Error('所选文档内容为空，请重新选择');
      }
      return { text, file: { name: file.name, size: file.size } };
    }
    const text = request.batchId && answer.value.trim() ? answer.value : request.form.interaction === 'choice'
      ? dialog.querySelector('input[name="user-choice"]:checked')?.value : answer.value;
    if (!text?.trim()) {
      throw Error(request.form.interaction === 'choice' ? '请选择一个选项后再确认' : '请填写补充内容后再确认');
    }
    return { text };
  }

  async function submit(stop = false) {
    const request = pending;
    error.hidden = true;
    form.querySelectorAll('button,input,select,textarea').forEach(control => { control.disabled = true; });
    try {
      const next = stop ? await invoke('runs.cancel', request.runId).then(() => invoke('runs.get', request.runId))
        : await invoke(request.batchId ? 'runs.answer' : 'runs.confirm', { runId: request.runId,
          ...(request.batchId ? { batchId: request.batchId, questionId: request.questionId }
            : { nodeId: request.nodeId, requestId: request.form.id }), ...await readAnswer(request) });
      onConfirmed(next);
    } catch (failure) {
      if (pending?.form.id === request.form.id) {
        error.textContent = failure.message;
        error.hidden = false;
      }
    } finally {
      form.querySelectorAll('button,input,select,textarea').forEach(control => { control.disabled = false; });
    }
  }
  // Plugin frames do not allow native form submissions; confirmation stays on the host RPC bridge.
  dialog.querySelector('[data-confirm]').onclick = () => submit();
  dialog.querySelector('[data-stop]').onclick = () => submit(true);

  return {
    show(run) {
      const batch = run?.status === 'waiting' ? run.pending?.interaction : null;
      const question = batch?.questions[batch.currentIndex];
      const next = question ? { id: `${batch.id}:${question.id}`, title: `第 ${batch.currentIndex + 1} / ${batch.questions.length} 题`,
        prompt: [batch.context, question.question].filter(Boolean).join('\n\n'), options: question.options,
        interaction: question.options.length ? 'choice' : 'text' }
        : run?.status === 'waiting' && run.pending?.kind === 'manual' && run.pending.form;
      if (!next) {
        closePopup(dialog);
        pending = null;
        return;
      }
      if (pending?.form.id === next.id) {
        return;
      }
      pending = { runId: run.id, nodeId: run.pending.nodeId, required: run.pending.kind === 'service', form: next, batchId: batch?.id, questionId: question?.id };
      dialog.querySelector('h2').textContent = next.title;
      const sections = formatReviewSections(next.prompt, question?.question);
      dialog.querySelector('[data-question]').textContent = sections.length ? '' : formatUserInputPrompt(next.prompt);
      const review = dialog.querySelector('[data-review-sections]');
      review.replaceChildren();
      for (const section of sections) {
        const block = document.createElement(section.collapsed ? 'details' : 'section');
        block.className = 'user-input-review-section';
        const heading = document.createElement(section.collapsed ? 'summary' : 'h3');
        heading.textContent = section.title;
        block.append(heading);
        for (const item of section.items) {
          const card = document.createElement('article');
          const title = document.createElement('h4');
          title.textContent = `${item.priority ? `${item.priority} · ` : ''}${item.title}`;
          const detail = document.createElement('p');
          detail.textContent = item.detail;
          card.append(title, detail);
          block.append(card);
        }
        review.append(block);
      }
      dialog.querySelector('[data-later]').hidden = pending.required;
      answer.value = next.initialValue || '';
      fileInput.value = '';
      fileSource.value = 'system';
      fileSource.onchange();
      dialog.querySelector('[data-file-name]').textContent = '';
      dialog.querySelector('[data-text-input]').hidden = Boolean(next.interaction && next.interaction !== 'text' && !batch);
      dialog.querySelector('[data-file-input]').hidden = next.interaction !== 'file';
      dialog.querySelector('[data-choice-input]').hidden = next.interaction !== 'choice';
      dialog.querySelector('[data-options]').innerHTML = (next.options || []).map(option =>
        `<label class="choice-option"><input type="radio" name="user-choice" value="${escape(option)}">${escape(option)}</label>`).join('');
      error.hidden = true;
      if (!run.hostMessages || next.interaction === 'file') {
        showPopup(dialog, document.activeElement, { placement: 'center' });
        focusInput();
      } else {
        closePopup(dialog);
      }
    },
    open() {
      if (pending && !dialog.open) {
        showPopup(dialog, document.activeElement, { placement: 'center' });
        focusInput();
      }
    }
  };

  function focusInput() {
    dialog.querySelector('[data-text-input]:not([hidden]) textarea, [data-file-input]:not([hidden]) select, [data-choice-input]:not([hidden]) input')?.focus();
  }
}

