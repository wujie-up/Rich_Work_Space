import { prepareContextMenu } from '../../../../desk/src/resource/context-menu.js';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { el } from './ui.js';

// Read the running engine's choices instead of keeping a separate, potentially stale model catalog.
function nativeMenu(buffer, rows) {
  const lines = Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) || '');
  const start = lines.findIndex(line => /Select (?:Model|Reasoning)|选择.*(?:模型|推理)/i.test(line));
  if (start < 0) { return null; }
  const choices = lines.slice(start + 1).flatMap(line => {
    const match = line.match(/^\s*([›❯>])?\s*(\d+)[.)]\s+(.+?)\s*$/u);
    if (!match) { return []; }
    const [label, ...description] = match[3].split(/\s{2,}/);
    return [{ selected: !!match[1], label, description: description.join(' '), number: Number(match[2]) }];
  });
  const selected = choices.findIndex(choice => choice.selected);
  return selected < 0 ? null : { title: lines[start].trim(), choices, selected };
}

export function mountModelPicker({ terminal, send, onClose, onError }) {
  let panel;
  let snapshot;
  let signature = '';
  let waiting = false;
  let cancelling = false;
  let timer;
  let escapeTimer;
  const finish = () => {
    if (!panel) { return; }
    const closing = panel;
    panel = null;
    clearTimeout(timer);
    clearTimeout(escapeTimer);
    closePopup(closing);
    closing.remove();
    snapshot = null;
    onClose();
  };
  const fail = error => {
    onError(error);
    cancel();
  };
  const escape = async () => {
    try {
      await send('\x1b');
      // Some engines return from reasoning to models before returning to the composer.
      if (panel && cancelling) { escapeTimer = setTimeout(escape, 180); }
    } catch (error) {
      onError(error);
      finish();
    }
  };
  const cancel = () => {
    if (!panel || cancelling) { return; }
    cancelling = true;
    closePopup(panel);
    escape();
    clearTimeout(timer);
    timer = setTimeout(finish, 1500);
  };
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error('读取模型菜单超时，请重试')), 20000);
  };
  const select = async index => {
    if (waiting || cancelling) { return; }
    waiting = true;
    panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const delta = index - snapshot.selected;
    try {
      await send(`${(delta < 0 ? '\x1b[A' : '\x1b[B').repeat(Math.abs(delta))}\r`);
      armTimeout();
    } catch (error) { fail(error); }
  };
  return {
    get accepting() { return !!panel && !cancelling; },
    open(anchor) {
      signature = '';
      waiting = false;
      cancelling = false;
      panel = el('div', { class: 'context-menu terminal-model-menu', role: 'menu', 'aria-label': '切换模型', tabindex: -1 },
        el('p', { role: 'status', text: '正在读取模型列表…' }));
      panel.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
      panel.addEventListener('keydown', event => {
        const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const target = { ArrowDown: (index + 1) % buttons.length, ArrowUp: (index - 1 + buttons.length) % buttons.length,
          Home: 0, End: buttons.length - 1 }[event.key];
        if (target !== undefined) {
          event.preventDefault();
          buttons[target]?.focus();
        }
      });
      document.body.append(panel);
      prepareContextMenu(panel);
      showPopup(panel, anchor);
      panel.focus();
      armTimeout();
    },
    update(empty) {
      if (!panel) { return; }
      const menu = nativeMenu(terminal.buffer.active, terminal.rows);
      if (empty && (snapshot || cancelling)) { finish(); return; }
      if (!menu || cancelling) { return; }
      const next = JSON.stringify(menu);
      if (next === signature || waiting && menu.title === snapshot.title) { return; }
      snapshot = menu;
      signature = next;
      waiting = false;
      clearTimeout(timer);
      panel.replaceChildren(el('p', { class: 'terminal-model-heading',
        text: /Reasoning|推理/i.test(menu.title) ? '选择推理强度' : '选择模型' }));
      menu.choices.forEach((choice, index) => {
        const label = `${choice.selected ? '当前选择：' : ''}${choice.label}`;
        panel.append(el('button', { type: 'button', role: 'menuitem', 'aria-label': label, title: choice.description || choice.label,
          'aria-current': choice.selected ? 'true' : null, onclick: () => select(index) }, el('span', { text: choice.label })));
      });
      prepareContextMenu(panel);
      panel.querySelectorAll('button')[menu.selected]?.focus();
    },
    cancel,
    dispose: finish
  };
}
