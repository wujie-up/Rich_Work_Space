// Use a theme palette entry so cached native composer backgrounds also follow later theme changes.
export function terminalSurfaces() {
  let pending = '';
  return data => {
    const output = pending + data;
    pending = output.match(/(?:\x1b|\x1b\[[\d;:]*)$/)?.[0] || '';
    return output.slice(0, output.length - pending.length).replace(/\x1b\[[\d;]*m/g, sequence =>
      sequence.replace(/(?<=[\[;])48;2;(?:58;60;64|66;68;72|67;69;73|244;244;244|249;249;249)(?=[;m])/g, '48;5;255'));
  };
}
