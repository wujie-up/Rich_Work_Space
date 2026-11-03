import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/main/common/workspace.js';
import { mavenProjects } from '../src/main/common/maven-projects.js';

test('Maven discovery finds nested projects without traversing build output or symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['', 'modules/api', 'target/generated', 'node_modules/dependency']) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'pom.xml'), path ? '<project/>' : '<project><modules><module>modules/api</module></modules></project>');
  }
  await symlink(tmpdir(), join(root, 'outside'));
  const result = await mavenProjects(await Workspace.open(root));
  assert.deepEqual(result.projects.map(project => project.path), ['', 'modules/api']);
  assert.equal(result.truncated, false);
});

test('Maven discovery reports incomplete scans and observes cancellation', async () => {
  const workspace = { root: '/project', list: async () => ({ entries: [], truncated: true }) };
  assert.equal((await mavenProjects(workspace)).truncated, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(mavenProjects(workspace, controller.signal), { name: 'AbortError' });
});

test('Maven hierarchy follows declared modules, without directory nodes or inherited artifact names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-pom-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const poms = {
    '': '<project><artifactId>platform</artifactId><modules><module>services/admin</module></modules></project>',
    'services/admin': `<project><parent><artifactId>parent-name</artifactId></parent><artifactId>admin</artifactId>
      <!-- <modules><module>../../unrelated</module></modules> -->
      <modules><module>../../components/api/pom.xml</module></modules>
      <profiles><profile><modules><module>../../unrelated</module></modules></profile></profiles></project>`,
    'components/api': '<m:project><m:artifactId>admin-api</m:artifactId></m:project>',
    'unrelated': '<project><artifactId>standalone</artifactId></project>'
  };
  for (const [path, pom] of Object.entries(poms)) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'pom.xml'), pom);
  }
  const result = await mavenProjects(await Workspace.open(root));
  assert.deepEqual(result.projects.find(project => project.path === ''), { path: '', name: 'platform', parentPath: null });
  assert.deepEqual(result.projects.find(project => project.path === 'services/admin'),
    { path: 'services/admin', name: 'admin', parentPath: '' });
  assert.deepEqual(result.projects.find(project => project.path === 'components/api'),
    { path: 'components/api', name: 'admin-api', parentPath: 'services/admin' });
  assert.equal(result.projects.some(project => project.path === 'unrelated'), false);
});

test('Maven hierarchy ignores self references and cycles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-pom-cycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'child'));
  await writeFile(join(root, 'pom.xml'), '<project><modules><module>.</module><module>child</module></modules></project>');
  await writeFile(join(root, 'child/pom.xml'), '<project><modules><module>..</module></modules></project>');
  const { projects } = await mavenProjects(await Workspace.open(root));
  assert.equal(projects[0].parentPath, null);
  assert.equal(projects[1].parentPath, '');
});


test('Maven discovery bounds the project count', async () => {
  const workspace = { root: '/project', text: async () => '<project/>', list: async ({ path }) => ({ truncated: false, entries: path
    ? [{ name: 'pom.xml', directory: false, path: `${path}/pom.xml` }]
    : Array.from({ length: 201 }, (_, index) => ({ name: `module${index}`, path: `module${index}`, directory: true })) }) };
  const result = await mavenProjects(workspace);
  assert.equal(result.projects.length, 200);
  assert.equal(result.truncated, true);
});

test('Maven discovery follows reactor modules without spending its budget on source files', async () => {
  const scanned = [];
  const poms = {
    'pom.xml': '<project><modules><module>api</module><module>server</module></modules></project>',
    'api/pom.xml': '<project><modules><module>../shared/pom.xml</module></modules></project>',
    'shared/pom.xml': '<project><modules><module>../api</module></modules></project>',
    'server/pom.xml': '<project/>'
  };
  const workspace = {
    root: '/project',
    text: async path => poms[path],
    list: async ({ path }) => {
      scanned.push(path);
      const names = path === '' ? ['api', 'server', 'shared', 'src'] : path === 'api' ? ['src'] : [];
      const entries = names.map(name => ({ name, path: [path, name].filter(Boolean).join('/'), directory: true }));
      if (path === 'api/src') {
        entries.push(...Array.from({ length: 10001 }, (_, index) => ({ name: `${index}.java`, directory: false })));
      } else {
        entries.push({ name: 'pom.xml', path: [path, 'pom.xml'].filter(Boolean).join('/'), directory: false });
      }
      return { entries, truncated: false };
    }
  };
  const result = await mavenProjects(workspace);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.projects.map(project => project.path), ['', 'api', 'shared', 'server']);
  assert.deepEqual(scanned, ['', 'api', 'shared', 'server']);
});
