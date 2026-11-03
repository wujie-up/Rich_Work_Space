import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api, el, toast } from './ui.js';
import { saveClipboardImage } from './clipboard-images.js';
import { clipboardPaths } from '../shared/file-references.js';
import { mountFileReferences } from './file-references.js';
import { terminalDocumentLinks, openDocument } from './document-links.js';
import { emptyComposer, occupiedComposer } from '../shared/composer-state.js';
import { terminalColors as colors } from '../shared/terminal-colors.js';
import { terminalSurfaces } from '../shared/terminal-surfaces.js';
import { terminalMetadata } from '../shared/terminal-metadata.js';
import { mountModelPicker } from './terminal-model-picker.js';
import { mountTerminalRenderer } from './terminal-renderer.js';
import { mountTerminalTouch } from './terminal-touch.js';
import { currentFontSize, FONT_SIZE_EVENT } from './appearance.js';
export function mountTerminal(container, { session, protocol, replay, onModel, onComposerLayout }) {
  const surfaces = terminalSurfaces();
  const terminal = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: currentFontSize(), lineHeight: 1.3, scrollback: 3500,
    convertEol: false, allowProposedApi: false, disableStdin: true, smoothScrollDuration: 0, cursorStyle: 'bar', cursorWidth: 2, cursorBlink: true,
    minimumContrastRatio: 4.5, theme: colors[document.documentElement.dataset.theme || 'dark'] });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const screen = el('div', { class: 'terminal-screen' });
  container.classList.add('terminal-with-files');
  container.append(screen);
  terminal.open(screen);
  const disposeTouch = mountTerminalTouch(screen, terminal);
  const references = mountFileReferences(container, () => terminal.focus());
  const disposeRenderer = mountTerminalRenderer(terminal, session, navigator, () => new WebglAddon());
  const links = terminal.registerLinkProvider({ provideLinks(row, callback) {
    try {
      callback(terminalDocumentLinks(terminal.buffer.active, row).map(link => ({
        range: link.range, text: link.text,
        activate: () => openDocument(link.path, session.cwd).catch(error => toast(error.message))
      })));
    } catch (error) {
      console.error('[session:document-links]', { pluginId: session.pluginId, sessionId: session.id, row, error: error.stack });
      callback([]);
    }
  } });
  let disposed = false;
  let ready = !!replay;
  let placeholder = '';
  let modelPicker = false;
  const inputHint = el('span', { class: 'terminal-input-hint', hidden: true, 'aria-hidden': 'true' });
  const inputCursor = el('span', { class: 'terminal-input-cursor', hidden: true, 'aria-hidden': 'true' });
  screen.append(inputHint, inputCursor);
  const metadataMasks = [];
  let displayedModel = '';
  let sequence = -1;
  let pasting = Promise.resolve();
  let inputRevision = 0;
  let queuedInputs = 0;
  let composing = false;
  let reportVersion = 0;
  let reportFailed = false;
  const clientId = crypto.randomUUID();
  const reportComposer = (detached = false) => {
    if (replay || (!ready && !detached)) { return; }
    api.sessions.composer(session.pluginId, session.id, { clientId, version: ++reportVersion, detached, sequence, inputRevision,
      nativeDraft: !writing && !pendingOutput && occupiedComposer(terminal.buffer.active),
      nativeEmpty: !writing && !pendingOutput ? emptyComposer(terminal.buffer.active) : undefined,
      composing, empty: !detached && !modelPicker && !queuedInputs && !composing && !references.text() && !writing && !pendingOutput
        && emptyComposer(terminal.buffer.active) }).then(() => { reportFailed = false; }).catch(error => {
      if (!reportFailed && !disposed) {
        console.error('[session:composer-state]', { pluginId: session.pluginId, sessionId: session.id, error: error.stack });
      }
      reportFailed = true;
    });
  };
  const buffer = [];
  const write = (data) => api.sessions.write(session.pluginId, session.id, data);
  const inputError = error => {
    console.error('[session:input]', { pluginId: session.pluginId, sessionId: session.id, message: error.message, stack: error.stack });
    if (!disposed) { toast(error.message); }
  };
  const enqueueInput = action => {
    queuedInputs++;
    reportComposer();
    pasting = pasting.then(() => {
      if (!disposed) { return action(); }
    }).catch(inputError).finally(() => {
      queuedInputs--;
      if (!disposed) { reportComposer(); }
    });
  };
  const picker = mountModelPicker({ terminal, send: write, onError: inputError, onClose: () => {
    modelPicker = false;
    terminal.textarea.readOnly = false;
  } });
  const pasteData = text => terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
  const input = terminal.onData(data => {
    if (replay) { return; }
    // Serialize paste resolution and keystrokes so an immediate Enter cannot overtake a file reference.
    enqueueInput(async () => {
      const paths = data === '\r' ? references.text() : '';
      await write(paths ? `${pasteData(` ${paths} `)}\r` : data);
      if (paths) { references.clear(); }
    });
  });
  const paste = (event) => {
    if (modelPicker) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const images = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    const uriList = event.clipboardData?.getData('text/uri-list');
    const text = uriList || event.clipboardData?.getData('text/plain') || '';
    const paths = clipboardPaths(text, uriList ? 'text/uri-list' : 'text/plain');
    if (!images.length && !paths.length) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!ready || replay || disposed) {
      return;
    }
    const files = images.map((item) => item.getAsFile());
    enqueueInput(async () => {
      if (!files.length) {
        const resolved = await api.sessions.fileReferences(session.pluginId, session.id, paths);
        if (!disposed) {
          if (resolved.length) {
            references.add(resolved);
          } else {
            await write(pasteData(text));
          }
        }
        return;
      }
      for (const file of files) {
        if (disposed) {
          return;
        }
        const path = await saveClipboardImage(session, file);
        if (!disposed) {
          // Codex parses pasted paths with shell quoting, including spaces and apostrophes in the data directory.
          await write(pasteData(protocol === 'codex' ? `'${path.replaceAll("'", "'\\''")}'` : path));
        }
      }
    });
  };
  container.addEventListener('paste', paste, true);
  const compositionStart = () => { composing = true; reportComposer(); };
  const compositionEnd = () => { composing = false; reportComposer(); };
  container.addEventListener('compositionstart', compositionStart, true);
  container.addEventListener('compositionend', compositionEnd, true);
  // Native Agent TUIs use Escape to stop a turn; Ctrl+C can exit the whole CLI.
  const nativeInterrupt = protocol === 'codex' || session.adapterId === 'claude';
  const interrupt = () => {
    if (ready && !replay && !disposed) {
      console.info('[session:interrupt]', { pluginId: session.pluginId, sessionId: session.id, nativeInterrupt });
      enqueueInput(() => write(nativeInterrupt ? '\x1b' : '\x03'));
      terminal.focus();
    }
  };
  terminal.attachCustomKeyEventHandler((event) => {
    if (!ready) {
      return false;
    }
    if (modelPicker) {
      if (event.key === 'Escape' && event.type === 'keydown') { picker.cancel(); }
      return false;
    }
    if (nativeInterrupt && !event.isComposing && event.code === 'KeyC' && !event.metaKey
      && !event.shiftKey && (event.ctrlKey || event.altKey)) {
      event.preventDefault();
      if (event.type === 'keydown' && !event.repeat) {
        interrupt();
      }
      return false;
    }
    if (!event.isComposing && event.keyCode !== 229 && protocol === 'codex' && event.shiftKey && event.key === 'Enter') {
      if (event.type === 'keydown') {
        enqueueInput(() => write('\x1b[13;2u'));
      }
      return false;
    }
    return true;
  });
  let outputFrame;
  let pendingOutput = '';
  let writing = false;
  // Keep chunks bounded; xterm yields on its time budget instead of limiting full-screen redraws to 16 KB per frame.
  const flushOutput = () => {
    outputFrame = null;
    if (disposed || writing || !pendingOutput) {
      return;
    }
    let end = Math.min(16384, pendingOutput.length);
    const last = pendingOutput.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      end--;
    }
    const chunk = pendingOutput.slice(0, end);
    pendingOutput = pendingOutput.slice(end);
    writing = true;
    terminal.write(surfaces(chunk), () => {
      writing = false;
      if (!disposed && pendingOutput) {
        flushOutput();
      } else if (!disposed) { reportComposer(); }
    });
  };
  const apply = (event) => {
    if (event.sequence > sequence) {
      pendingOutput += event.data;
      if (!writing) {
        outputFrame ||= requestAnimationFrame(flushOutput);
      }
      sequence = event.sequence;
      inputRevision = event.inputRevision ?? 0;
    }
  };
  const off = replay ? () => {} : api.events.output((event) => {
    if (event.pluginId === session.pluginId && event.sessionId === session.id) {
      ready ? apply(event) : buffer.push(event);
    }
  });
  if (replay) {
    terminal.write(surfaces(replay.output || '（没有输出）'));
  } else {
    api.sessions.attach(session.pluginId, session.id).then((snapshot) => {
      if (disposed) {
        return;
      }
      sequence = snapshot.sequence;
      inputRevision = snapshot.inputRevision ?? 0;
      // Historical device queries must not inject responses into the live CLI. Parsing is asynchronous.
      terminal.write(surfaces(snapshot.data), () => {
        if (!disposed) {
          terminal.options.disableStdin = false;
          ready = true;
          terminal.textarea.readOnly = false;
          buffer.forEach(apply);
          buffer.length = 0;
          reportComposer();
        }
      });
    }).catch((error) => { if (!disposed) { toast(error.message); } });
  }
  // Keep model metadata and the coordinator placeholder aligned with the native composer.
  const renderInputMode = () => {
    if (disposed) { return; }
    const buffer = terminal.buffer.active;
    const empty = emptyComposer(buffer);
    if (modelPicker) { picker.update(empty); }
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const canvas = screen.querySelector('.xterm-screen');
    const height = canvas?.clientHeight / terminal.rows;
    if (onModel && height > 0) {
      try {
        const metadata = terminalMetadata(buffer);
        if (metadata.model && metadata.model !== displayedModel) {
          displayedModel = metadata.model;
          onModel(displayedModel);
        }
        const visible = metadata.rows.map(index => index - buffer.viewportY).filter(index => index >= 0 && index < terminal.rows);
        const bounds = canvas.getBoundingClientRect();
        const origin = screen.getBoundingClientRect();
        visible.forEach((index, position) => {
          if (!metadataMasks[position]) {
            metadataMasks[position] = el('div', { class: 'terminal-metadata-mask', 'aria-hidden': 'true' });
            screen.append(metadataMasks[position]);
          }
          const mask = metadataMasks[position];
          mask.hidden = false;
          mask.style.left = `${bounds.left - origin.left}px`;
          mask.style.width = `${bounds.width}px`;
          mask.style.top = `${bounds.top - origin.top + index * height}px`;
          mask.style.height = `${height}px`;
          mask.style.background = terminal.options.theme.background;
        });
        metadataMasks.slice(visible.length).forEach(mask => { mask.hidden = true; });
      } catch (error) {
        metadataMasks.forEach(mask => { mask.hidden = true; });
        console.error('[session:metadata-render]', { pluginId: session.pluginId, sessionId: session.id }, error);
      }
    }
    const live = !modelPicker && (empty || occupiedComposer(buffer)) && row >= 0 && row < terminal.rows && height > 0;
    onComposerLayout?.({ live, modelPicker, top: live ? Math.max(0, canvas.getBoundingClientRect().top
      - screen.getBoundingClientRect().top - Number(screen.dataset.composerOffset || 0) + (row - 1) * height) : 0 });
    // Only replace the native caret while the custom placeholder covers it; drafts retain xterm's own caret.
    inputCursor.hidden = !ready || replay || !live || composing || !placeholder || !empty;
    if (!inputCursor.hidden) {
      const bounds = canvas.getBoundingClientRect();
      const origin = screen.getBoundingClientRect();
      inputCursor.style.left = `${bounds.left - origin.left + buffer.cursorX * canvas.clientWidth / terminal.cols}px`;
      inputCursor.style.top = `${bounds.top - origin.top + row * height}px`;
      inputCursor.style.height = `${height}px`;
      inputCursor.style.background = terminal.options.theme.cursor;
    }
    inputHint.hidden = !placeholder || !empty || !live;
    if (!inputHint.hidden) {
      inputHint.textContent = placeholder;
      const bounds = canvas.getBoundingClientRect();
      const origin = screen.getBoundingClientRect();
      inputHint.style.left = `${bounds.left - origin.left + buffer.cursorX * canvas.clientWidth / terminal.cols}px`;
      inputHint.style.right = `${origin.right - bounds.right}px`;
      inputHint.style.top = `${bounds.top - origin.top + row * height}px`;
      inputHint.style.height = `${height}px`;
      // Match the native composer surface so replacing its placeholder does not cut a dark stripe through it.
      const cell = buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX);
      inputHint.style.background = cell?.isBgPalette() && cell.getBgColor() === 255
        ? terminal.options.theme.extendedAnsi[239] : terminal.options.theme.background;
      inputHint.style.color = `color-mix(in srgb, ${terminal.options.theme.foreground} 65%, ${terminal.options.theme.background})`;
    }
  };
  const inputRender = terminal.onRender(renderInputMode);
  const inputScroll = terminal.onScroll(renderInputMode);
  const setInputMode = ({ placeholder: nextPlaceholder = '' }) => {
    placeholder = nextPlaceholder;
    container.dataset.inputMode = placeholder ? 'leader' : 'normal';
    renderInputMode();
  };
  const reportTimer = replay ? null : setInterval(() => { if (!disposed) { reportComposer(); } }, 1000);
  let timer;
  let dimensions = '';
  const fit = () => {
    if (disposed || !screen.clientWidth || !screen.clientHeight) {
      return;
    }
    const proposed = fitAddon.proposeDimensions();
    if (!proposed) {
      return;
    }
    terminal.resize(Math.min(500, proposed.cols), Math.max(2, Math.min(200, proposed.rows)));
    const size = `${terminal.cols}:${terminal.rows}`;
    if (!replay && size !== dimensions) {
      dimensions = size;
      api.sessions.resize(session.pluginId, session.id, terminal.cols, terminal.rows).catch(error => {
        dimensions = '';
        console.error('[session:resize]', { pluginId: session.pluginId, sessionId: session.id, size, error: error.stack });
      });
    }
  };
  // Refit the existing terminal and PTY so font changes preserve the active session and unsent input.
  const resizeFont = () => {
    try {
      if (terminal.options.fontSize === currentFontSize()) { return; }
      terminal.options.fontSize = currentFontSize();
      fit();
      renderInputMode();
    } catch (error) {
      console.error('[session:font-size]', { pluginId: session.pluginId, sessionId: session.id }, error);
    }
  };
  window.addEventListener(FONT_SIZE_EVENT, resizeFont);
  const observer = new ResizeObserver(() => {
    // Alternate-screen shrink discards rows; debounce local and PTY resizing together so no unreported size clears the TUI.
    clearTimeout(timer);
    timer = setTimeout(fit, 80);
  });
  observer.observe(screen);
  return { terminal, fit, interrupt, setInputMode,
    switchModel: anchor => {
      // Native pickers retain engine-specific models and context; never overwrite a draft to issue a command.
      if (!ready || replay || disposed || modelPicker || queuedInputs || composing || references.text() || writing || pendingOutput
        || !emptyComposer(terminal.buffer.active)) {
        toast('请等待会话空闲，并先提交或清除未发送的输入');
        return;
      }
      modelPicker = true;
      terminal.textarea.readOnly = true;
      picker.open(anchor);
      console.info('[session:model-picker]', { pluginId: session.pluginId, sessionId: session.id });
      enqueueInput(async () => {
        try {
          await write('/model');
          // Let the TUI process the command before Enter; a combined write may be classified as a paste.
          await new Promise(resolve => setTimeout(resolve, 150));
          if (!disposed && picker.accepting) { await write('\r'); }
        } catch (error) {
          picker.dispose();
          throw error;
        }
      });
    }, focus: () => terminal.focus(), setTheme: (theme) => { terminal.options.theme = colors[theme]; },
    clear: () => {
      if (ready && !replay && !disposed) {
        // A nonempty draft makes Ctrl+C clear input rather than quit an empty composer.
        enqueueInput(async () => {
          await write('\x1b[200~ \x1b[201~\x03');
          references.clear();
        });
        terminal.focus();
      }
    },
    newline: () => {
      if (ready && !replay && !disposed) {
        enqueueInput(() => write('\x1b[13;2u'));
        terminal.focus();
      }
    },
    dispose: () => {
      reportComposer(true);
      disposed = true;
      picker.dispose();
      clearInterval(reportTimer);
      clearTimeout(timer);
      cancelAnimationFrame(outputFrame);
      container.removeEventListener('paste', paste, true);
      container.removeEventListener('compositionstart', compositionStart, true);
      container.removeEventListener('compositionend', compositionEnd, true);
      off();
      observer.disconnect();
      window.removeEventListener(FONT_SIZE_EVENT, resizeFont);
      input.dispose();
      inputRender.dispose();
      inputScroll.dispose();
      links.dispose();
      disposeRenderer();
      disposeTouch();
      references.dispose();
      terminal.dispose();
      screen.remove();
      container.classList.remove('terminal-with-files');
    } };
}
