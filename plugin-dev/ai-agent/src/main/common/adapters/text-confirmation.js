const REQUESTS = [
  /(?:请|麻烦|烦请)(?:你|您)?[^。！？\n]{0,32}(?:确认|选择|回复|告知|提供|补充|决定|指定|告诉我)/,
  /(?:需要|等待|等)(?:你|您)(?:的)?[^。！？\n]{0,16}(?:回复|确认|选择|决定)/,
  /(?:你|您)(?:希望|想|倾向|决定|选择)[^。！？\n]{0,64}(?:哪|什么|是否)/,
  /(?:你|您)(?:选|选择|决定)(?:一个|一种|哪|什么)/,
  /(?:什么|哪|多少|是否|能否|可否|要不要|需不需要|能不能|还是|吗|呢)[^。！？\n]*[?？]\s*$/,
  /\b(?:please\s+(?:confirm|choose|select|reply|provide|tell me)|let me know)\b/i,
  /\b(?:can|could|would) you\b[^.!?\n]{0,80}\b(?:confirm|choose|select|provide)\b/i,
  /\b(?:which|what|where|when|how|shall|should|would|could|can|do|are|is)\b[^.!?\n]*\?\s*$/i
];

// Only assistant prose counts: examples, quoted questions and URLs do not ask the user to act.
export function needsUserConfirmation(text = '') {
  const prose = text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/`[^`\n]*`|https?:\/\/\S+|“[^”]*”|「[^」]*」|"[^"\n]*"/g, '')
    .replace(/[*_]/g, '').trim();
  return REQUESTS.some(pattern => pattern.test(prose));
}
