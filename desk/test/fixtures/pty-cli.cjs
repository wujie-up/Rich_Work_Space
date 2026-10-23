const { spawn } = require('node:child_process');
process.stdout.write('\x1b[32mREADY 中文\x1b[0m\r\n');
if (process.argv.includes('--child')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  console.log('CHILD=' + child.pid);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  const input = data.toString();
  console.log('INPUT=' + JSON.stringify(input));
  if (input.includes('query-now')) {
    process.stdout.write('\x1b[6n');
  }
  if (input.includes('exit-now')) {
    process.exit(0);
  }
});
process.on('SIGWINCH', () => console.log('SIZE=' + process.stdout.columns + 'x' + process.stdout.rows));
setInterval(() => process.stdout.write('tick\r\n'), 500);
