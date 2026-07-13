import React from 'react';

/**
 * Tab / Shift+Tab handling inside a GitHub-flavored markdown table in a
 * <textarea>: moves the cursor to the next/previous cell and re-aligns the
 * whole table (pads columns so the source is readable). Tab at the last cell
 * appends a new row. Returns true if it handled the key (and prevented default);
 * false otherwise, so callers can fall through to other handlers.
 *
 * Deliberately only realigns on Tab (a structural move), never on every
 * keystroke, so typing stays smooth. Wrapped in try/catch: on any unexpected
 * shape it bails out and lets the default Tab happen.
 */
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);

const splitCells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

const isSeparatorRow = (line: string) =>
  isTableRow(line) && splitCells(line).every((c) => /^:?-+:?$/.test(c));

function formatTable(rows: string[][], isSep: boolean[], colCount: number): { lines: string[]; widths: number[] } {
  const widths = new Array(colCount).fill(3);
  rows.forEach((cells, i) => {
    if (isSep[i]) return;
    for (let c = 0; c < colCount; c++) widths[c] = Math.max(widths[c], (cells[c] || '').length);
  });
  const lines = rows.map((cells, i) =>
    isSep[i]
      ? '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |'
      : '| ' + widths.map((w, c) => (cells[c] || '').padEnd(w)).join(' | ') + ' |'
  );
  return { lines, widths };
}

export function handleTableTab(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  onChange: (value: string) => void
): boolean {
  if (e.key !== 'Tab') return false;

  try {
    const ta = e.currentTarget;
    const pos = ta.selectionStart;
    const lines = value.split('\n');
    const lineStarts: number[] = [];
    { let o = 0; for (const l of lines) { lineStarts.push(o); o += l.length + 1; } }

    let curLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (pos >= lineStarts[i] && pos <= lineStarts[i] + lines[i].length) { curLine = i; break; }
    }
    if (!isTableRow(lines[curLine])) return false;

    // Expand to the whole contiguous table block.
    let top = curLine, bot = curLine;
    while (top - 1 >= 0 && isTableRow(lines[top - 1])) top--;
    while (bot + 1 < lines.length && isTableRow(lines[bot + 1])) bot++;

    const rows: string[][] = [];
    const isSep: boolean[] = [];
    let colCount = 0;
    for (let i = top; i <= bot; i++) {
      rows.push(splitCells(lines[i]));
      isSep.push(isSeparatorRow(lines[i]));
      colCount = Math.max(colCount, splitCells(lines[i]).length);
    }

    // Current cell coordinate.
    const inLine = pos - lineStarts[curLine];
    const pipesBefore = (lines[curLine].slice(0, inLine).match(/\|/g) || []).length;
    const curRow = curLine - top;
    let curCol = Math.min(Math.max(0, pipesBefore - 1), colCount - 1);

    const rowCount = rows.length;
    const nextNonSep = (r: number, dir: number) => {
      let x = r + dir;
      while (x >= 0 && x < rowCount && isSep[x]) x += dir;
      return x;
    };

    const forward = !e.shiftKey;
    let tRow: number;
    let tCol: number;

    if (isSep[curRow]) {
      // Cursor sat on the separator; jump to the first cell of the adjacent row.
      const r = nextNonSep(curRow, forward ? 1 : -1);
      tRow = r >= 0 && r < rowCount ? r : curRow;
      tCol = 0;
    } else if (forward) {
      if (curCol + 1 < colCount) { tRow = curRow; tCol = curCol + 1; }
      else {
        const nr = nextNonSep(curRow, 1);
        if (nr < 0 || nr >= rowCount) {
          rows.push(new Array(colCount).fill(''));
          isSep.push(false);
          tRow = rows.length - 1; tCol = 0;
        } else { tRow = nr; tCol = 0; }
      }
    } else {
      if (curCol - 1 >= 0) { tRow = curRow; tCol = curCol - 1; }
      else {
        const pr = nextNonSep(curRow, -1);
        if (pr < 0) { tRow = curRow; tCol = 0; }
        else { tRow = pr; tCol = colCount - 1; }
      }
    }

    const { lines: formatted, widths } = formatTable(rows, isSep, colCount);
    const blockStart = lineStarts[top];
    const origBlockEnd = lineStarts[bot] + lines[bot].length;
    const newValue = value.slice(0, blockStart) + formatted.join('\n') + value.slice(origBlockEnd);

    // Caret at the target cell's content (select existing content so it can be typed over).
    let cellStart = 2; // past "| "
    for (let j = 0; j < tCol; j++) cellStart += widths[j] + 3; // "cell" + " | "
    let lineOffset = 0;
    for (let i = 0; i < tRow; i++) lineOffset += formatted[i].length + 1;
    const contentLen = (rows[tRow][tCol] || '').length;
    const caret = blockStart + lineOffset + cellStart;

    e.preventDefault();
    onChange(newValue);
    requestAnimationFrame(() => ta.setSelectionRange(caret, caret + contentLen));
    return true;
  } catch {
    return false;
  }
}
