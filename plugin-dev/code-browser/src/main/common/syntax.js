const keywords = new Set(('abstract assert async await boolean break byte case catch char class const continue debugger default '
  + 'delete do double else enum export extends false final finally float for from function if implements import in instanceof '
  + 'int interface let long native new null of package private protected public record return short static strictfp super switch '
  + 'synchronized this throw throws transient true try typeof var void volatile while with yield').split(' '));

// Ordered alternatives keep strings/comments opaque and preserve every source character for safe DOM rendering.
export function tokenize(source, markup = false) {
  const pattern = /<!--[\s\S]*?(?:-->|$)|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"""[\s\S]*?(?:"""|$)|"(?:\\[\s\S]|[^"\\\r\n])*"?|'(?:\\[\s\S]|[^'\\\r\n])*'?|`(?:\\[\s\S]|[^`\\])*`?|[\p{ID_Start}_$][\p{ID_Continue}$]*|\b\d+(?:[\w.]*\w)?|\s+|[^\s]/gu;
  return [...source.matchAll(pattern)].map(match => {
    const text = match[0];
    let kind = '';
    if (/^(?:\/\/|\/\*|<!--)/.test(text)) {
      kind = 'comment';
    } else if (/^["'`]/.test(text)) {
      kind = 'string';
    } else if (keywords.has(text)) {
      kind = 'keyword';
    } else if (/^\d/.test(text)) {
      kind = 'number';
    } else if (/^[\p{ID_Start}_$]/u.test(text)) {
      kind = markup && /<\/?\s*$/.test(source.slice(Math.max(0, match.index - 4), match.index)) ? 'tag' : 'identifier';
    }
    return { text, kind, offset: match.index };
  });
}
