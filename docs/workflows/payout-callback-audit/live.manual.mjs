// Manual read-only bridge: the controlling tool session supplies existing metabase_query responses on stdin.
import { createInterface } from 'node:readline';
import { collectPayoutAudit } from '../../../plugin-dev/work-flow/src/main/common/payout-audit.js';
import { savePayoutReport } from '../../../plugin-dev/work-flow/src/main/common/payout-report.js';
import { randomUUID } from 'node:crypto';

const directory = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!directory) {
  throw Error('Use --output=<absolute report directory>');
}
process.stdin.setRawMode?.(true);
const input = createInterface({ input: process.stdin, terminal: false });
let receive;
input.on('line', line => {
  if (receive) {
    const resolve = receive;
    receive = null;
    resolve(JSON.parse(line));
  }
});
try {
  const audit = await collectPayoutAudit(query => new Promise(resolve => {
    receive = resolve;
    process.stdout.write(JSON.stringify({ kind: 'query', query }) + '\n');
  }));
  const path = await savePayoutReport(audit, { directory, runId: randomUUID() });
  process.stdout.write(JSON.stringify({ kind: 'result', complete: audit.complete, path, asOf: audit.asOf,
    candidateEvents: audit.candidateEvents, matchedRecords: audit.records.length, queryCount: audit.queries.length, failures: audit.failures }) + '\n');
} finally {
  input.close();
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}
