// Share the textarea's exact typography so wrapping agrees across navigation, gutters and scroll mapping.
export function createEditorMirror(editor) {
  const mirror = document.createElement('div');
  const style = getComputedStyle(editor);
  for (const name of ['font', 'padding', 'boxSizing', 'tabSize', 'wordBreak', 'letterSpacing']) {
    mirror.style[name] = style[name];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', width: `${editor.clientWidth}px`,
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  return mirror;
}

// A mirror includes wrapped lines, keeping source navigation and scroll mapping accurate in narrow windows.
export function measureEditorOffsets(editor, offsets) {
  const mirror = createEditorMirror(editor);
  let previous = 0;
  const markers = offsets.map(offset => {
    mirror.append(document.createTextNode(editor.value.slice(previous, offset)));
    const marker = document.createElement('span');
    mirror.append(marker);
    previous = offset;
    return marker;
  });
  mirror.append(document.createTextNode(editor.value.slice(previous)));
  editor.parentElement.append(mirror);
  try {
    return markers.map(marker => marker.offsetTop);
  } finally {
    mirror.remove();
  }
}

export function selectEditorRange(editor, start, end = start) {
  const [top] = measureEditorOffsets(editor, [start]);
  editor.setSelectionRange(start, end);
  editor.scrollTop = top - parseFloat(getComputedStyle(editor).paddingTop);
}
