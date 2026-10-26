const activity = state => process.stdout.write(`\x1b]7501;app=codex:${state}\x07`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('READY\r\n');
activity('state=idle');
process.stdin.on('data', data => {
  const command = data.toString();
  if (command === 'working') {
    activity('state=working');
  } else if (command === 'blocked') {
    activity('state=blocked:kind=permission');
    process.stdout.write('\r\nNative choices: 1. Allow once  2. Deny\r\n');
  } else if (command === 'history') {
    process.stdout.write(Array.from({ length: 400 }, (_, index) => `history ${index}\r\n`).join(''));
  } else if (command === 'document') {
    process.stdout.write('\x1b[2J\x1b[H[报告](report.md)\r\n');
  } else {
    process.stdout.write(`\r\nCHOICE=${JSON.stringify(command)}\r\n`);
    activity('state=idle');
  }
});
