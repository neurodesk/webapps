// Pure-JS Bruker ParaVision JCAMP-DX parser ported from BrkRaw v0.5.7
// (src/brkraw/core/jcamp.py and src/brkraw/core/parameters.py, GPL-3.0-only).

const VALUE_SHAPE_RE = /^\(([^()]*)\)\s*(.*)$/s;

/** Strip Bruker `<...>` angle brackets and `^` separators into clean readable text. */
export function stripJcampString(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (text.startsWith('<') && text.endsWith('>')) {
    text = text.slice(1, -1);
  }
  return text.replace(/\^+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseShapeTuple(raw) {
  const parts = raw.split(',').map((p) => p.trim());
  if (!parts.length) return null;
  const dims = [];
  for (const part of parts) {
    if (!/^-?\d+$/.test(part)) return null;
    dims.push(Number.parseInt(part, 10));
  }
  return dims;
}

function splitShapeAndData(raw) {
  if (!raw) return [null, null];
  const s = raw.trim();
  if (!s) return [null, null];
  const m = VALUE_SHAPE_RE.exec(s);
  if (!m) return [null, s];
  const left = m[1].trim();
  const right = m[2].trim() || null;
  const shape = parseShapeTuple(left);
  if (shape) return [shape, right];
  return [null, s];
}

function toNumber(token) {
  const t = token.trim();
  if (!t) return t;
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : t;
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  }
  return t;
}

function splitTopLevelCommas(s) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let angleDepth = 0;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '<') {
      angleDepth++;
      buf += ch;
    } else if (ch === '>') {
      buf += ch;
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (angleDepth === 0 && ch === '(') {
      depth++;
      buf += ch;
    } else if (angleDepth === 0 && ch === ')') {
      depth--;
      buf += ch;
    } else if (angleDepth === 0 && ch === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length) parts.push(buf.trim());
  return parts;
}

function splitTokensAngleAware(s) {
  const tokens = [];
  let buf = '';
  let angleDepth = 0;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '<') {
      if (buf && angleDepth === 0) {
        tokens.push(buf);
        buf = '';
      }
      angleDepth++;
      buf += ch;
    } else if (ch === '>') {
      buf += ch;
      if (angleDepth > 0) {
        angleDepth--;
        if (angleDepth === 0) {
          tokens.push(buf);
          buf = '';
        }
      }
    } else if (angleDepth === 0 && /\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens.map((t) => t.trim()).filter(Boolean);
}

function isSingleOuterParen(s) {
  const t = s.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  let depth = 0;
  let angleDepth = 0;
  let escape = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (angleDepth === 0) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth === 0 && i !== t.length - 1) return false;
  }
  return depth === 0;
}

function parseLeafTokens(text) {
  const tokens = splitTokensAngleAware(text);
  const values = tokens.map(toNumber);
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return values;
}

function parseSegment(seg) {
  const s = seg.trim();
  if (!s) return null;
  const items = [];
  let buf = '';
  let depth = 0;
  let startIdx = -1;
  let angleDepth = 0;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      if (depth === 0) buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      if (depth === 0) buf += ch;
      escape = true;
      continue;
    }
    if (ch === '<') {
      angleDepth++;
      if (depth === 0) buf += ch;
    } else if (ch === '>') {
      if (depth === 0) buf += ch;
      if (angleDepth > 0) angleDepth--;
    } else if (angleDepth === 0 && ch === '(') {
      if (depth === 0) {
        const leaf = buf.trim();
        if (leaf) {
          const val = parseLeafTokens(leaf);
          if (val !== null) items.push(val);
        }
        buf = '';
        startIdx = i;
      }
      depth++;
    } else if (angleDepth === 0 && ch === ')') {
      depth--;
      if (depth === 0 && startIdx >= 0) {
        items.push(parseNested(s.slice(startIdx, i + 1)));
        startIdx = -1;
      }
    } else if (depth === 0) {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail) {
    const val = parseLeafTokens(tail);
    if (val !== null) items.push(val);
  }
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return items;
}

function parseNested(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (!s.includes('(') && !s.includes(')') && !s.includes(',') && !/\s/.test(s)) {
    return toNumber(s);
  }
  while (isSingleOuterParen(s)) {
    s = s.slice(1, -1).trim();
    if (!s) return [];
  }
  const parts = splitTopLevelCommas(s);
  if (parts.length === 1) return parseSegment(parts[0]);
  const results = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const val = parseSegment(part);
    if (val !== null) results.push(val);
  }
  return results;
}

/** Expand Bruker `@N*(val)` repeat encodings anywhere in a flat or nested token array. */
function expandRepeatTokens(data) {
  if (!Array.isArray(data)) return data;
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item === 'string' && /^@\d+\*$/.test(item) && i + 1 < data.length) {
      const count = Number.parseInt(item.slice(1, -1), 10);
      const val = data[i + 1];
      if (count > 0 && count <= 500_000) {
        for (let k = 0; k < count; k++) out.push(val);
        i++;
        continue;
      }
    }
    if (Array.isArray(item)) {
      // Check if an inner leaf list itself contains `@N*` markers (e.g. `1 2 @4*` followed by `(0)`).
      if (item.length && typeof item[item.length - 1] === 'string' && /^@\d+\*$/.test(item[item.length - 1]) && i + 1 < data.length) {
        for (let j = 0; j < item.length - 1; j++) out.push(item[j]);
        const count = Number.parseInt(item[item.length - 1].slice(1, -1), 10);
        const val = data[i + 1];
        if (count > 0 && count <= 500_000) {
          for (let k = 0; k < count; k++) out.push(val);
          i++;
          continue;
        }
      }
      out.push(item);
    } else {
      out.push(item);
    }
  }
  return out;
}

function flattenArray(arr, out = []) {
  for (const item of arr) {
    if (Array.isArray(item)) flattenArray(item, out);
    else out.push(item);
  }
  return out;
}

function reshapeList(flat, shape, offset = 0) {
  if (shape.length === 1) {
    return flat.slice(offset, offset + shape[0]);
  }
  const stride = shape.slice(1).reduce((a, b) => a * b, 1);
  const out = [];
  for (let i = 0; i < shape[0]; i++) {
    out.push(reshapeList(flat, shape.slice(1), offset + i * stride));
  }
  return out;
}

function toStringValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const hasNested = value.some((v) => Array.isArray(v));
    if (hasNested) {
      return value.map((v) => (Array.isArray(v) ? v.join(' ') : String(v))).join('; ');
    }
    return value.join(' ');
  }
  return value === null || value === undefined ? '' : String(value);
}

function formatParamValue(shape, rawData) {
  if (shape === null) return rawData;
  if (rawData === null || rawData === undefined) return shape;

  let data = expandRepeatTokens(rawData);
  if (typeof data === 'string') return data;

  const total = shape.reduce((a, b) => a * b, 1);
  // If data is a flat/nested array whose flattened length matches total (and not a list of structured tuples like VisuFGOrderDesc):
  const isStructuredTuple =
    shape.length === 1 &&
    Array.isArray(data) &&
    ((shape[0] === 1 && !Array.isArray(data[0]) && data.length > 1) ||
      (shape[0] > 1 && data.length === shape[0] && Array.isArray(data[0])));

  if (!isStructuredTuple) {
    const flat = Array.isArray(data) ? flattenArray(data) : [data];
    if (flat.length === total) {
      return reshapeList(flat, shape);
    }
  }

  if (shape.length === 1) {
    if (shape[0] === 1) return data;
    return Array.isArray(data) ? data : [data];
  }

  // Symbolic ref list e.g. shape (N, 65) with N angle-bracketed strings
  if (shape.length === 2 && Array.isArray(data) && data.length === shape[0]) {
    if (data.every((item) => typeof item === 'string' && item.trim().startsWith('<') && item.trim().endsWith('>'))) {
      return data;
    }
  }

  return data;
}

/**
 * Parse a Bruker JCAMP-DX parameter file (`subject`, `acqp`, `method`, `visu_pars`, `reco`)
 * into `{ header, params, comments, exceptions }`, matching `brkraw.core.parameters.Parameters`.
 */
export function parseJcampText(text) {
  const header = Object.create(null);
  const params = Object.create(null);
  const comments = [];
  const exceptions = [];
  const rawLines = [];

  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\$\$/.test(raw)) {
      comments.push(raw.replace(/^\$\$+/, '').trim());
    } else {
      rawLines.push(raw);
    }
  }

  const joined = rawLines.join(' ');
  const chunks = joined.split('##');
  for (const chunk of chunks) {
    if (!chunk) continue;
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      exceptions.push(trimmed);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    const rawValue = trimmed.slice(eqIdx + 1);
    const [shape, dataRaw] = splitShapeAndData(rawValue);
    const parsedData = typeof dataRaw === 'string' ? parseNested(dataRaw) : dataRaw;

    if (!key.startsWith('$')) {
      header[key] = toStringValue(parsedData);
    } else {
      const paramKey = key.slice(1);
      params[paramKey] = formatParamValue(shape, parsedData);
    }
  }

  return {
    header,
    params,
    comments,
    exceptions,
    get(key, fallback = undefined) {
      if (Object.hasOwn(params, key)) return params[key];
      if (Object.hasOwn(header, key)) return header[key];
      return fallback;
    },
    hasKeyMatching(substr) {
      const q = substr.toLowerCase();
      return Object.keys(params).some((k) => k.toLowerCase().includes(q))
        || Object.keys(header).some((k) => k.toLowerCase().includes(q));
    },
  };
}

/** Decode bytes (UTF-8 / Latin-1 tolerant) as JCAMP-DX. */
export function parseJcampBytes(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return parseJcampText(decoder.decode(bytes));
}
