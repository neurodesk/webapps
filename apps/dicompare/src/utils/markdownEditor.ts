import React from 'react';

/**
 * Keydown handler for a markdown <textarea> that continues lists and blockquotes
 * on Enter (like most markdown editors):
 *  - "- item"  / "* item" / "+ item"  → new bullet on the next line
 *  - "1. item"                         → next number
 *  - "> quote"                         → new quote line
 *  - Enter on an *empty* marker         → removes the marker (ends the list)
 *
 * Call from the textarea's onKeyDown, passing the current value + its setter.
 */
export function handleMarkdownListContinuation(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  onChange: (value: string) => void
): void {
  if (e.key !== 'Enter' || e.shiftKey) return;

  const ta = e.currentTarget;
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return; // don't interfere with a ranged selection

  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const line = value.slice(lineStart, pos);

  // Table row: add a new empty row on Enter; an empty row exits the table.
  const tableRow = line.match(/^(\s*)\|(.+)\|\s*$/);
  if (tableRow) {
    const cells = tableRow[2].split('|');
    const isSeparator = cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
    // Don't add a row from the header line (its next line is the separator).
    const allLines = value.split('\n');
    const lineIndex = value.slice(0, lineStart).split('\n').length - 1;
    const nextLine = allLines[lineIndex + 1] || '';
    const nextIsSeparator =
      /^\s*\|(.+)\|\s*$/.test(nextLine) &&
      nextLine.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').every((c) => /^\s*:?-+:?\s*$/.test(c));

    if (!isSeparator && !nextIsSeparator) {
      e.preventDefault();
      if (cells.every((c) => c.trim() === '')) {
        // Empty row → exit the table.
        onChange(value.slice(0, lineStart) + value.slice(pos));
        requestAnimationFrame(() => ta.setSelectionRange(lineStart, lineStart));
        return;
      }
      const emptyRow = tableRow[1] + '| ' + cells.map(() => '  ').join(' | ') + ' |';
      const insert = '\n' + emptyRow;
      const caret = pos + tableRow[1].length + 2; // inside first cell of the new row
      onChange(value.slice(0, pos) + insert + value.slice(pos));
      requestAnimationFrame(() => ta.setSelectionRange(caret, caret));
      return;
    }
  }

  const ul = line.match(/^(\s*)([-*+])(\s+)(.*)$/);
  const ol = line.match(/^(\s*)(\d+)\.(\s+)(.*)$/);
  const quote = line.match(/^(\s*)(>)(\s?)(.*)$/);
  const match = ul || ol || quote;
  if (!match) return;

  const content = match[4];
  e.preventDefault();

  // Empty item → end the list by clearing the marker on this line.
  if (content.trim() === '') {
    const newValue = value.slice(0, lineStart) + value.slice(pos);
    onChange(newValue);
    requestAnimationFrame(() => ta.setSelectionRange(lineStart, lineStart));
    return;
  }

  let marker: string;
  if (ol) {
    marker = `${ol[1]}${parseInt(ol[2], 10) + 1}.${ol[3]}`;
  } else if (ul) {
    marker = `${ul[1]}${ul[2]}${ul[3]}`;
  } else {
    marker = `${quote![1]}>${quote![3] || ' '}`;
  }

  const insert = '\n' + marker;
  const newValue = value.slice(0, pos) + insert + value.slice(pos);
  const caret = pos + insert.length;
  onChange(newValue);
  requestAnimationFrame(() => ta.setSelectionRange(caret, caret));
}
