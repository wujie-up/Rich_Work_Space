import assert from 'node:assert/strict';
import test from 'node:test';
let receive;
globalThis.window = { addEventListener(_event, listener) { receive = listener; } };
globalThis.parent = { postMessage({ id }) {
  queueMicrotask(() => receive({ source: parent, origin: 'desk-host://desktop',
    data: { type: 'desk:result', id, value: { theme: 'dark' } } }));
} };
globalThis.document = { documentElement: { dataset: {} } };
const { bindDeployment, deploymentForm } = await import('../src/renderer/deployment-form.js');

function form(value) {
  const elements = Object.fromEntries(Object.entries({ language: 'javascript', entry: 'server.mjs', interpreter: '',
    source: value.source, fields: '[]', 'script-env': JSON.stringify(value.env) }).map(([name, value]) => [name, { value }]));
  return { elements, querySelector: () => ({}) };
}

test('script environment configuration is separate from field declarations and survives source updates', () => {
  const value = { source: 'console.log(process.env.METABASE_USERNAME)', deployment: 'existing',
    env: { METABASE_SESSION: 'old-session' } };
  assert.match(deploymentForm(value), /name="script-env"/);
  const editor = form(value);
  const read = bindDeployment(editor, value);
  assert.deepEqual(read().env, value.env);
  editor.elements['script-env'].value = JSON.stringify({ ...value.env, METABASE_USERNAME: 'analyst', METABASE_PASSWORD: 'local-password' });
  editor.elements.source.value += '\n// edit';
  const saved = read();
  assert.equal(saved.env.METABASE_PASSWORD, 'local-password');
  assert.equal(saved.env.METABASE_SESSION, 'old-session');
  assert.equal(saved.source.includes('local-password'), false);
  assert.equal(saved.source.includes('process.env.METABASE_USERNAME'), true);
});

test('script environment configuration rejects non-object and non-string values', () => {
  const editor = form({ source: '', env: {} });
  const read = bindDeployment(editor, {});
  for (const value of ['null', '[]', '"text"', '{"TOKEN":123}', '{broken']) {
    editor.elements['script-env'].value = value;
    assert.throws(read);
  }
});
