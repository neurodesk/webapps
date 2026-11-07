// A small JavaScript/TypeScript tokenizer that finds string literals and skips comments and
// regular expressions. It reads only what the embedded version check needs: each string's text,
// its offset, and the property or variable name it is assigned to (`key: "…"`, `KEY = '…'`,
// `"key": "…"`). JSX text is not tokenized, so an apostrophe in JSX text would open a string.

const NAME = /[\p{ID_Continue}$]/u;
// After these words a `/` starts a regular expression, not a division.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * The string literals of `source`, template literal chunks included.
 * @returns {{ value: string, start: number, key: string | null }[]} `value` is the raw
 *   source text between the quotes, escapes unprocessed, starting at offset `start`; `key` is
 *   the name before a `:` or `=` that immediately precedes the literal.
 */
export function stringLiterals(source) {
  const strings = [];
  const tokens = []; // significant tokens so far: { kind: 'name' | 'string' | 'regex' | 'punct', value }
  const templateDepths = []; // brace depth at which each open `${` resumes its template
  let depth = 0;
  let i = 0;

  const keyBefore = () => {
    const [key, operator] = tokens.slice(-2);
    if (!key || !operator || operator.kind !== 'punct' || !/^[:=]$/.test(operator.value)) return null;
    return key.kind === 'name' || key.kind === 'string' ? key.value : null;
  };
  const regexAllowed = () => {
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.kind === 'name') return KEYWORDS_BEFORE_EXPRESSION.has(last.value);
    if (last.kind !== 'punct') return false;
    return !/^[)\]}]$/.test(last.value);
  };
  // Reads raw string text from `i` to the closing quote (or a template's `${`), skipping escapes.
  const readString = (quote) => {
    const start = i;
    while (i < source.length && source[i] !== quote && !(quote === '`' && source.startsWith('${', i))) {
      if (source[i] === '\n' && quote !== '`') break;
      i += source[i] === '\\' ? 2 : 1;
    }
    const value = source.slice(start, i);
    const key = keyBefore();
    strings.push({ value, start, key });
    tokens.push({ kind: 'string', value });
    if (source.startsWith('${', i)) {
      templateDepths.push(depth);
      tokens.push({ kind: 'punct', value: '${' });
      i += 2;
    } else {
      i += 1;
    }
  };

  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i += 1;
    } else if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === '`') {
      i += 1;
      readString(char);
    } else if (char === '}' && templateDepths.at(-1) === depth) {
      templateDepths.pop();
      i += 1;
      readString('`');
    } else if (char === '/' && regexAllowed()) {
      let inClass = false;
      for (i += 1; i < source.length && source[i] !== '\n'; i += 1) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
      }
      i += 1;
      tokens.push({ kind: 'regex' });
    } else if (NAME.test(char)) {
      const start = i;
      while (i < source.length && NAME.test(source[i])) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i) });
    } else {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      tokens.push({ kind: 'punct', value: char });
      i += 1;
    }
  }
  return strings;
}
