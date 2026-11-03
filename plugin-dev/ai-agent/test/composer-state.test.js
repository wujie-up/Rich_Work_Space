import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyComposer, occupiedComposer } from '../src/shared/composer-state.js';

const buffer = (text, cursorX = 2, extra = {}) => ({ baseY: 20, cursorY: 3, cursorX,
  getLine: row => row === 23 ? { isWrapped: false, translateToString: () => text,
    getCell: () => ({ isDim: () => true }), ...extra } : undefined });

test('only a native empty prompt or dim placeholder at its start is safe', () => {
  assert.equal(emptyComposer(buffer('› ')), true);
  assert.equal(emptyComposer(buffer('›')), true);
  assert.equal(emptyComposer(buffer('❯')), true);
  assert.equal(emptyComposer(buffer('❯ ')), true);
  assert.equal(emptyComposer(buffer('❯\u00a0 ')), true);
  assert.equal(emptyComposer(buffer('❯\u00a0 draft', 2)), false);
  assert.equal(emptyComposer(buffer('› Ask Codex to do anything')), true);
  assert.equal(emptyComposer(buffer('› Ask Codex to do anything', 5)), false);
  assert.equal(emptyComposer(buffer('› my draft')), false);
  assert.equal(emptyComposer(buffer('working')), false);
  assert.equal(emptyComposer(buffer('› ', 2, { isWrapped: true })), false);
  assert.equal(emptyComposer(buffer('› Ask Codex to do anything', 2, { getCell: () => ({ isDim: () => false }) })), false);
  assert.equal(emptyComposer(buffer('› Ask Codex to do anything', 2, { getCell: () => undefined })), false);
});

test('configured provider model names retain an identifiable native status footer', () => {
  const b = buffer('› Ask Codex to do anything');
  const line = b.getLine(23);
  b.length = 26;
  b.getLine = row => row === 23 ? line : { translateToString: () => row === 25 ? 'fixture-model default · /tmp/project' : '' };
  assert.equal(emptyComposer(b), true);
});


test('only an occupied native prompt acknowledges a pending draft, never a working screen', () => {
  assert.equal(occupiedComposer(buffer('working', 7)), false);
  assert.equal(occupiedComposer(buffer('› Ask Codex to do anything')), false);
  assert.equal(occupiedComposer(buffer('› draft', 7)), true);
  assert.equal(occupiedComposer(buffer('❯\u00a0 draft', 8)), true);
});
