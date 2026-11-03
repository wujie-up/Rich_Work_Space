import { api, el, modal, run } from './ui.js';

function renderSections(body, request) {
  if (!request.sections?.length) {
    body.append(el('div', { class: 'plugin-message-question', text: request.question }));
    return;
  }
  for (const section of request.sections) {
    const block = el(section.collapsed ? 'details' : 'section', { class: 'plugin-message-section' });
    block.append(el(section.collapsed ? 'summary' : 'h3', { text: section.title }));
    for (const item of section.items) {
      const heading = el('div', { class: 'plugin-message-card-heading' },
        item.priority ? el('span', { class: 'plugin-message-priority', text: item.priority }) : null,
        el('h4', { text: item.title }));
      block.append(el('article', { class: 'plugin-message-card' }, heading,
        item.detail !== item.title ? el('p', { text: item.detail }) : null));
    }
    body.append(block);
  }
}

// Keep the live prompt and its draft until delivery succeeds; owner revocation can always dismiss it.
export function mountPluginMessages() {
  let active;
  let refreshing = false;
  async function refresh() {
    if (active || refreshing) { return; }
    refreshing = true;
    let requests;
    try { requests = await api.messages.list(); } finally { refreshing = false; }
    const request = requests[0];
    if (!request) { return; }
    const current = { id: request.id, revoked: false, submitting: false };
    active = current;
    const answer = await modal(request.title, ({ body, actions, finish, dialog }) => {
      current.finish = finish;
      dialog.dataset.pluginMessage = request.id;
      body.append(el('p', { class: 'plugin-message-source', text: request.pluginId }));
      renderSections(body, request);
      const input = el('textarea', { rows: 5, placeholder: '输入回复', 'aria-label': '回复' });
      const errorText = el('p', { class: 'plugin-message-error', role: 'alert' });
      input.value = sessionStorage.getItem(`plugin-message:${request.id}`) || '';
      input.oninput = () => sessionStorage.setItem(`plugin-message:${request.id}`, input.value);
      if (!request.optionsOnly) { body.append(input); }
      body.append(errorText);
      const submit = async text => {
        if (current.submitting || !text.trim()) { return; }
        current.submitting = true;
        errorText.textContent = '';
        dialog.querySelectorAll('button,textarea').forEach(control => { control.disabled = true; });
        try {
          await api.messages.respond(request.id, { text });
          sessionStorage.removeItem(`plugin-message:${request.id}`);
          finish(text);
        } catch (error) {
          console.error('[plugin:message-submit-failed]', { requestId: request.id }, error);
          errorText.textContent = error.message;
        } finally {
          current.submitting = false;
          dialog.querySelectorAll('button,textarea').forEach(control => { control.disabled = false; });
        }
      };
      dialog.addEventListener('cancel', event => {
        if (current.submitting) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, { capture: true });
      for (const option of request.options) {
        actions.append(el('button', { type: 'button', text: option, onclick: () => submit(option) }));
      }
      if (!request.required) {
        actions.append(el('button', { type: 'button', text: '稍后处理', onclick: () => finish(null) }));
      }
      if (!request.optionsOnly) {
        actions.append(el('button', { type: 'button', text: '确认', onclick: () => submit(input.value) }));
      }
    }, { wide: true, placement: request.placement, dismissible: !request.required });
    active = undefined;
    if (answer === null && !current.revoked) { await api.messages.defer(request.id); }
    run(refresh);
  }
  api.events.messagesChanged(() => {
    if (active) {
      const current = active;
      api.messages.list().then(items => {
        if (active === current && !items.some(item => item.id === current.id)) {
          current.revoked = true;
          current.finish?.(null);
        }
      }).catch(error => console.error('[plugin:message-refresh-failed]', { requestId: current.id }, error));
    }
    run(refresh);
  });
  run(refresh);
}
