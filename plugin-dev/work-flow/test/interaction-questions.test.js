import test from 'node:test';
import assert from 'node:assert/strict';
import { questionBatch, answerQuestion } from '../src/main/common/interaction-questions.js';

test('questions preserve IDs/options and accept exactly the current question once', () => {
  const batch = questionBatch('request-one', [{ id: 'a', question: 'One', options: [{ label: 'Yes' }] }, 'Two', 'Three']);
  assert.equal(batch.questions.length, 3);
  assert.deepEqual(batch.questions[0].options, ['Yes']);
  assert.throws(() => answerQuestion(batch, 'wrong', 'ok'), /失效/);
  answerQuestion(batch, 'a', 'Yes');
  assert.equal(batch.currentIndex, 1);
  assert.throws(() => answerQuestion(batch, 'a', 'again'), /失效/);
  const restored = structuredClone(batch);
  answerQuestion(restored, 'request-one:1', 'answer two');
  answerQuestion(restored, 'request-one:2', 'answer three');
  assert.equal(restored.currentIndex, 3);
  assert.deepEqual(restored.answers, { a: 'Yes', 'request-one:1': 'answer two', 'request-one:2': 'answer three' });
});
