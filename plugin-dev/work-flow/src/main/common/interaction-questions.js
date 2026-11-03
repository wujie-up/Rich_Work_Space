import { fail } from './errors.js';

// Keep native IDs stable so a saved batch can resume without asking answered questions again.
export function questionBatch(id, questions, context = '') {
  return { id, currentIndex: 0, answers: {}, context, questions: questions.map((question, index) => {
    const entry = typeof question === 'string' ? { question } : question;
    return { id: String(entry.id ?? `${id}:${index}`), question: entry.question || entry.prompt,
      options: (entry.options || []).map(option => typeof option === 'string' ? option : option.label),
      descriptions: (entry.options || []).map(option => typeof option === 'string' ? '' : option.description || '') };
  }) };
}

export function manualQuestions(form) {
  if (form.interaction === 'file') { return null; }
  const lines = form.prompt.split('\n');
  let questions;
  const context = lines.filter(line => {
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string' || item?.question || item?.prompt)) {
        questions = value;
        return false;
      }
    } catch { /* A plain text prompt is a single question. */ }
    return true;
  }).join('\n');
  return questionBatch(form.id, questions || [{ question: form.prompt, options: form.options }], questions ? context : '');
}

export function answerQuestion(batch, questionId, text) {
  if (batch.questions[batch.currentIndex]?.id !== questionId) {
    throw fail('QUESTION_EXPIRED', '该问题已失效，请刷新当前问题');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 90000) {
    throw fail('INVALID_ARGUMENT', '请填写有效的回答');
  }
  batch.answers[questionId] = text;
  batch.currentIndex += 1;
  return batch.currentIndex === batch.questions.length;
}
