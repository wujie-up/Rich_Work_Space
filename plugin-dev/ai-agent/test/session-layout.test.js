import test from 'node:test';
import assert from 'node:assert/strict';
import { placeSessions, moveSession, savePositions, snapSessionSize } from '../src/renderer/session-layout.js';

const items = [{ id: 'a', width: 4, height: 3 }, { id: 'b', width: 4, height: 3 }, { id: 'c', width: 4, height: 3 }];
test('resizing snaps to nearby neighbor edges and dimensions, otherwise to the nearest grid', () => {
  const neighbor = { left: 0, top: 0, width: 660, height: 405 };
  assert.deepEqual(snapSessionSize({ left: 0, top: 480, width: 653, height: 398 }, [neighbor]), { width: 660, height: 405 });
  assert.deepEqual(snapSessionSize({ left: 24, top: 24, width: 641, height: 374 }, [neighbor]), { width: 636, height: 381 });
  assert.deepEqual(snapSessionSize({ left: 0, top: 0, width: 621, height: 350 }, []), { width: 612, height: 348 });
  assert.deepEqual(snapSessionSize({ left: 0, top: 0, width: 667, height: 350 }, [
    { left: 672, top: 0, width: 660, height: 405 }
  ]), { width: 660, height: 348 }, 'keep the gutter instead of pushing a nearby neighbor into another row');
});
test('new cards fill available grid cells and restore preferred positions', () => {
  const layout = placeSessions(items, { a: { col: 4, row: 4 } }, 8);
  assert.deepEqual(layout.a, { col: 4, row: 4, width: 4, height: 3 });
  assert.equal(layout.b.row, 0);
  assert.equal(layout.c.col, 4);
});
test('moving into a neighbor pushes only collisions without mutating the starting snapshot', () => {
  const start = placeSessions(items, {}, 12);
  const moved = moveSession(start, 'a', { col: 4, row: 0 }, 12);
  assert.equal(moved.a.col, 4);
  assert.equal(moved.b.col, 8);
  assert.equal(moved.c.row, 3);
  assert.equal(start.a.col, 0);
  assert.equal(start.b.col, 4);
  assert.deepEqual(moveSession(start, 'a', { col: 4, row: 0 }, 12), moved);
});
test('moving to empty grid space preserves neighbors; narrow views keep every card reachable', () => {
  const start = placeSessions(items, {}, 12);
  const moved = moveSession(start, 'b', { col: 0, row: 6 }, 12);
  assert.deepEqual(moved.a, start.a);
  assert.deepEqual(moved.c, start.c);
  const narrow = placeSessions(items, moved, 3);
  for (const position of Object.values(narrow)) {
    assert.equal(position.col, 0);
    assert.equal(position.width, 3);
    assert.ok(position.row >= 0);
  }
});

test('partial edge cells remain usable without dropping the gutter between neighboring cards', () => {
  const columns = (1000 + 12) / 24;
  const cards = [{ id: 'a', width: (360 + 12) / 24, height: 3 }, { id: 'b', width: (600 + 12) / 24, height: 3 }];
  const start = placeSessions(cards, {}, columns);
  const preview = moveSession(start, 'b', { col: 100, row: 0 }, columns);
  assert.equal(preview.b.col * 24 + 600, 1000, 'the card reaches the canvas edge without reserving an outer gutter');
  assert.ok(preview.b.col * 24 - 360 >= 12, 'the inter-card gutter remains intact');
  const saved = savePositions({}, start, preview, 'b');
  assert.deepEqual(placeSessions(cards, saved, columns), preview);
  assert.equal(moveSession(preview, 'b', { col: 0, row: 3 }, columns).b.col, 0);
});

test('committing a move pins automatic neighbors so preview, release and reload agree', () => {
  const start = placeSessions(items, {}, 12);
  const preview = moveSession(start, 'b', { col: 0, row: 6 }, 12);
  const preferences = savePositions({}, start, preview, 'b');
  assert.deepEqual(placeSessions(items, preferences, 12), preview);
  const narrow = placeSessions(items, preferences, 4);
  const moved = moveSession(narrow, 'b', { col: 0, row: 9 }, 4);
  const next = savePositions(preferences, narrow, moved, 'b');
  assert.deepEqual(next.c, preferences.c, 'temporary narrow-screen clamping must not overwrite a neighbor preference');
});

test('expanding the visually first card pushes lower cards down regardless of session order', () => {
  const cards = ['b', 'c', 'a'].map(id => ({ id, width: 8, height: 2 }));
  const preferences = { a: { col: 0, row: 0 }, b: { col: 0, row: 2 }, c: { col: 0, row: 4 } };
  const collapsed = placeSessions(cards, preferences, 8);
  const expanded = placeSessions(cards.map(card => ({ ...card, height: card.id === 'a' ? 18 : 2 })), preferences, 8);
  assert.deepEqual(expanded.a, { ...collapsed.a, height: 18 });
  assert.equal(expanded.b.row, 18);
  assert.equal(expanded.c.row, 20);
  assert.deepEqual(placeSessions(cards, preferences, 8), collapsed, 'collapsing restores the original spacing');
  assert.deepEqual(preferences.b, { col: 0, row: 2 }, 'temporary displacement must not overwrite saved positions');
});

test('expanding a card keeps its column and pushes only cards underneath it', () => {
  const cards = [{ id: 'lower', width: 4, height: 2 }, { id: 'right', width: 4, height: 2 },
    { id: 'top', width: 4, height: 10 }];
  const preferences = { lower: { col: 0, row: 2 }, right: { col: 4, row: 0 }, top: { col: 0, row: 0 } };
  const layout = placeSessions(cards, preferences, 8);
  assert.deepEqual(layout.top, { col: 0, row: 0, width: 4, height: 10 });
  assert.deepEqual(layout.right, { col: 4, row: 0, width: 4, height: 2 });
  assert.deepEqual(layout.lower, { col: 0, row: 10, width: 4, height: 2 });
});

test('automatic cards above saved cards keep their place during expansion and collapse', () => {
  const cards = ['saved', 'automatic'].map(id => ({ id, width: 8, height: 2 }));
  const preferences = { saved: { col: 0, row: 2 } };
  const collapsed = placeSessions(cards, preferences, 8);
  assert.equal(collapsed.automatic.row, 0);
  const expanded = placeSessions(cards.map(card => ({ ...card, height: card.id === 'automatic' ? 18 : 2 })),
    preferences, 8, collapsed);
  assert.equal(expanded.automatic.row, 0);
  assert.equal(expanded.saved.row, 18);
  assert.deepEqual(placeSessions(cards, preferences, 8, expanded), collapsed);
});

test('automatic cards keep their anchors when reflow repeats', () => {
  const cards = [{ id: 'a', width: 4, height: 9 }, { id: 'b', width: 4, height: 3 },
    { id: 'c', width: 2, height: 9 }, { id: 'd', width: 2, height: 8 }];
  const preferences = { a: { col: 0, row: 8 }, d: { col: 4, row: 4 } };
  const initial = placeSessions(cards, preferences, 8);
  assert.deepEqual(placeSessions(cards, preferences, 8, initial), initial);
  assert.deepEqual(placeSessions(cards, preferences, 8, placeSessions(cards, preferences, 8, initial)), initial);
});
