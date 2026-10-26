import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, toast } from './ui.js';
import { saveClipboardImage } from './clipboard-images.js';
import { documentLinks, openDocument } from './document-links.js';

const colors = {
  dark: { background: '#202227', foreground: '#e5e7eb', cursor: '#c4b5fd', selectionBackground: '#63588d88', black: '#30333a' },
  light: { background: '#ffffff', foreground: '#282c35', cursor: '#6950b9', selectionBackground: '#d8cff5', black: '#282c35' }
};
export function mountTerminal(container, { session, protocol, replay }) {
  const terminal = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: 11, lineHeight: 1.3, scrollback: 3500,
    convertEol: false, allowProposedApi: false, disableStdin: true, cursorStyle: 'bar', cursorWidth: 1,
    minimumContrastRatio: 4.5, theme: colors[document.documentElement.dataset.theme || 'dark'] });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  const links = terminal.registerLinkProvider({ provideLinks(row, callback) {
    const line = terminal.buffer.active.getLine(row - 1);
    const text = line?.translateToString(true) || '';
    // Terminal cells and string offsets differ for Chinese and other wide characters.
    const column = offset => {
      let length = 0;
      for (let index = 0; index < (line?.length || 0); index++) {
        const cell = line.getCell(index);
        if (!cell?.getWidth()) { continue; }
        if (length >= offset) { return index + 1; }
        length += cell.getChars().length || 1;
      }
      return terminal.cols + 1;
    };
    callback(documentLinks(text).map(link => ({
      range: { start: { x: column(link.start), y: row }, end: { x: column(link.end) - 1, y: row } },
      text: text.slice(link.start, link.end),
      activate: () => openDocument(link.path, session.cwd).catch(error => toast(error.message))
    })));
  } });
  let disposed = false;
  let ready = !!replay;
  let sequence = -1;
  let pasting = Promise.resolve();
  const buffer = [];
  const write = (data) => api.sessions.write(session.pluginId, session.id, data).catch((error) => toast(error.message));
  const input = terminal.onData((data) => { if (!replay) { write(data); } });
  const paste = (event) => {
    const images = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!images.length) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!ready || replay) {
      return;
    }
    const files = images.map((item) => item.getAsFile());
    pasting = pasting.then(async () => {
      for (const file of files) {
        if (disposed) {
          return;
        }
        const path = await saveClipboardImage(session, file);
        if (!disposed) {
          // Codex parses pasted paths with shell quoting, including spaces and apostrophes in the data directory.
          terminal.paste(protocol === 'codex' ? `'${path.replaceAll("'", "'\\''")}'` : path);
        }
      }
    }).catch((error) => {
      console.error('[session:image-paste]', { pluginId: session.pluginId, sessionId: session.id, message: error.message });
      if (!disposed) { toast(error.message); }
    });
  };
  container.addEventListener('paste', paste, true);
  terminal.attachCustomKeyEventHandler((event) => {
    if (!ready) {
      return false;
    }
    if (!event.isComposing && event.keyCode !== 229 && protocol === 'codex' && event.shiftKey && event.key === 'Enter') {
      if (event.type === 'keydown') {
        write('\x1b[13;2u');
      }
      return false;
    }
    return true;
  });
  let outputFrame;
  let pendingOutput = '';
  const apply = (event) => {
    if (event.sequence > sequence) {
      pendingOutput += event.data;
      outputFrame ||= requestAnimationFrame(() => {
        outputFrame = null;
        if (!disposed) { terminal.write(pendingOutput); }
        pendingOutput = '';
      });
      sequence = event.sequence;
    }
  };
  const off = replay ? () => {} : api.events.output((event) => {
    if (event.pluginId === session.pluginId && event.sessionId === session.id) {
      ready ? apply(event) : buffer.push(event);
    }
  });
  if (replay) {
    terminal.write(replay.output || '（没有输出）');
  } else {
    api.sessions.attach(session.pluginId, session.id).then((snapshot) => {
      if (disposed) {
        return;
      }
      sequence = snapshot.sequence;
      // Historical device queries must not inject responses into the live CLI. Parsing is asynchronous.
      terminal.write(snapshot.data, () => {
        if (!disposed) {
          terminal.options.disableStdin = false;
          ready = true;
          buffer.forEach(apply);
          buffer.length = 0;
        }
      });
    }).catch((error) => { if (!disposed) { toast(error.message); } });
  }
  let timer;
  let fitFrame;
  let dimensions = '';
  const fit = () => {
    if (disposed || !container.clientWidth || !container.clientHeight) {
      return;
    }
    fitAddon.fit();
    const size = `${terminal.cols}:${terminal.rows}`;
    if (!replay && size !== dimensions) {
      dimensions = size;
      clearTimeout(timer);
      timer = setTimeout(() => api.sessions.resize(session.pluginId, session.id, Math.min(500, terminal.cols), Math.min(200, terminal.rows))
        .catch(() => {}), 80);
    }
  };
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fit);
  });
  observer.observe(container);
  return { terminal, fit, focus: () => terminal.focus(), setTheme: (theme) => { terminal.options.theme = colors[theme]; },
    clear: () => {
      if (ready && !replay && !disposed) {
        // A nonempty draft makes Ctrl+C clear input rather than quit an empty composer.
        write('\x1b[200~ \x1b[201~\x03');
        terminal.focus();
      }
    },
    newline: () => {
      if (ready && !replay && !disposed) {
        write('\x1b[13;2u');
        terminal.focus();
      }
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      cancelAnimationFrame(outputFrame);
      cancelAnimationFrame(fitFrame);
      container.removeEventListener('paste', paste, true);
      off();
      observer.disconnect();
      input.dispose();
      links.dispose();
      terminal.dispose();
    } };
}
