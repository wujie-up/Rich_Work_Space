import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/main/common/storage.js';

export async function temporaryStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'work-desk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new Storage(root);
}

export function fakePty() {
  let sequence = 1000;
  const terminals = [];
  const spawn = () => {
    const terminal = {
      pid: ++sequence, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
      write(data) { this.data(data); }, resize() {}, kill() { this.exit({ exitCode: 0 }); }
    };
    terminals.push(terminal);
    return terminal;
  };
  return { spawn, terminals };
}

export async function fixture(storage, id = 'test-agent') {
  const dir = join(storage.root, `source-${id}`);
  await mkdir(dir);
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 2, dataVersion: 1, main: 'index.mjs' }));
  await writeFile(join(dir, 'index.mjs'), 'export function activate(c) { c.views.register({id:"sessions",title:"Sessions",entry:"index.html"}); } export function deactivate() {}');
  return dir;
}
