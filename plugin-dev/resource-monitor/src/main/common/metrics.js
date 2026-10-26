const sum = (values) => values.length && values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;

// Each live process belongs to the nearest registered root, so nested roots cannot be counted twice.
export function aggregate(owners, sample, previous) {
  const processes = new Map((sample.processes || []).map(row => [row.pid, row]));
  const roots = new Map();
  const rootStates = new Map();
  for (const owner of owners) {
    for (const pid of [owner.pid, ...owner.ownedPids]) {
      const key = `${owner.instanceId}:${pid}`;
      const known = previous?.roots?.get(key);
      const current = processes.get(pid);
      // A PID is an observation handle, not a durable identity; a retired root stays retired for this instance.
      const identity = sample.processes === null ? known : known === null || known !== undefined && known !== current?.start
        ? null : current?.start ?? null;
      rootStates.set(key, identity);
      if (identity !== null && identity !== undefined) {
        roots.set(pid, owner.pluginId);
      }
    }
  }
  const groups = new Map(owners.map(owner => [owner.pluginId, []]));
  for (const row of processes.values()) {
    const seen = new Set();
    let pid = row.pid;
    while (pid > 1 && !seen.has(pid)) {
      if (roots.has(pid)) {
        groups.get(roots.get(pid)).push(row);
        break;
      }
      seen.add(pid);
      pid = processes.get(pid)?.ppid;
    }
  }
  const baseline = { time: sample.time, processes: new Map(), roots: rootStates };
  const seconds = previous ? (sample.time - previous.time) / 1000 : 0;
  const rows = owners.map(owner => {
    const owned = groups.get(owner.pluginId);
    const cpu = [];
    const received = [];
    const sent = [];
    for (const row of owned) {
      const identity = `${owner.instanceId}:${row.start}`;
      const before = previous?.processes.get(row.pid);
      const network = sample.network ? sample.network.get(row.pid) || { received: 0, sent: 0 } : null;
      baseline.processes.set(row.pid, { identity, cpuMs: row.cpuMs, network });
      const comparable = seconds > 0 && before?.identity === identity;
      cpu.push(comparable && row.cpuMs >= before.cpuMs ? (row.cpuMs - before.cpuMs) / (seconds * 10 * sample.cores) : null);
      const connected = comparable && network && before.network
        && network.received >= before.network.received && network.sent >= before.network.sent;
      received.push(connected ? (network.received - before.network.received) / seconds : null);
      sent.push(connected ? (network.sent - before.network.sent) / seconds : null);
    }
    const cpuTotal = sum(cpu);
    return { pluginId: owner.pluginId, name: owner.name, instanceId: owner.instanceId, processCount: owned.length,
      cpu: cpuTotal === null ? null : Math.min(100, cpuTotal), memory: sum(owned.map(row => row.rss)),
      received: sum(received), sent: sum(sent) };
  });
  const total = Object.fromEntries(['cpu', 'memory', 'received', 'sent'].map(key => [key, sum(rows.map(row => row[key]))]));
  if (total.cpu !== null) {
    total.cpu = Math.min(100, total.cpu);
  }
  return { time: sample.time, rows, total, processError: sample.processError || null, networkError: sample.networkError || null, baseline };
}
