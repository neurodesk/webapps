// A small JavaScript/TypeScript tokenizer that finds string literals and skips comments and
// regular expressions. It reads only what the embedded version check needs: each string's text,
// its offset, and the property or variable name it is assigned to (`key: "…"`, `KEY = '…'`,
// `"key": "…"`, `const KEY: Type = '…'`). Without a parser it does not handle:
// - JSX text: an apostrophe in `<p>Don't</p>` would open a string, so callers skip .jsx/.tsx;
// - a regex right after a statement's closing `)` or `}` (`if (x) /re/.test(s)` reads as division);
// - type annotations other than one name (`const KEY: Record<K, V> = '…'` has no key);
// - `cond ? version : '…'`, which reads `version` as the key.

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
    const [name, colon, type, operator] = tokens.slice(-4);
    if (operator?.kind === 'punct' && operator.value === '=' && colon?.value === ':' && name?.kind === 'name' && type?.kind === 'name') {
      return name.value;
    }
    const [key, last] = tokens.slice(-2);
    if (!key || !last || last.kind !== 'punct' || !/^[:=]$/.test(last.value)) return null;
    return key.kind === 'name' || key.kind === 'string' ? key.value : null;
  };
  // A `/` divides after a value (a name, number, string, `)`, `]`, `}`, `x++`, `obj.return`)
  // and starts a regular expression elsewhere, keywords such as `return` included.
  const regexAllowed = () => {
    const [before, last] = tokens.slice(-2);
    if (!last) return true;
    if (last.kind === 'name') return before?.value !== '.' && KEYWORDS_BEFORE_EXPRESSION.has(last.value);
    if (last.kind !== 'punct') return false;
    if (/^[+-]$/.test(last.value) && before?.value === last.value) return false;
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
