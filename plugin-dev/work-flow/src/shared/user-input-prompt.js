// Only a consecutive A/B/... list is reformatted; ordinary letter references stay untouched.
export function formatQuestionOptions(prompt) {
  return prompt.split('\n').map(line => {
    const marker = /(^|[：:；;。！？ \t])[ \t]*([A-Z])([、，,：:）)]|\.(?=[ \t]))[ \t]*/gu;
    const options = [...line.matchAll(marker)];
    if (options.length < 2 || !options.every((option, index) => option[2].charCodeAt(0) === 65 + index)) {
      return line;
    }
    return line.replace(marker, (match, prefix, letter, punctuation, offset) =>
      `${prefix.trimEnd()}${offset || prefix.trim() ? '\n\n' : ''}${match.slice(match.indexOf(letter))}`);
  }).join('\n');
}

// Question arrays are human-facing here; node outputs retain their original JSON contract.
export function formatUserInputPrompt(prompt) {
  return formatQuestionOptions(prompt.split('\n').map(line => {
    if (!line.trim().startsWith('[')) {
      return line;
    }
    let questions;
    try {
      questions = JSON.parse(line);
    } catch {
      // Free-form context can contain brackets without being a question list.
      return line;
    }
    return Array.isArray(questions) && questions.length && questions.every(question => typeof question === 'string')
      ? questions.map((question, index) => `${index + 1}. ${question}`).join('\n') : line;
  }).join('\n'));
}
