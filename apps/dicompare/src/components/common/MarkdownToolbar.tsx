import React, { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Heading, List, ListOrdered, Link as LinkIcon, Code, Quote, Layers, ChevronDown, Table as TableIcon } from 'lucide-react';

interface MarkdownToolbarProps {
  /** Ref to the textarea being edited. */
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  /** Current markdown value. */
  value: string;
  /** Called with the new value after a toolbar action. */
  onChange: (value: string) => void;
  /** If provided, shows a "Link to acquisition" button that inserts internal
   *  #acq: links to these acquisitions (by name). */
  acquisitionNames?: string[];
  disabled?: boolean;
}

/**
 * A small formatting toolbar for a markdown <textarea>. Buttons wrap/insert
 * markdown syntax at the current selection so users don't have to know the
 * syntax. The "Link to acquisition" button inserts an internal [name](#acq:name)
 * reference that the renderer resolves against the current schema (no URL needed).
 */
const MarkdownToolbar: React.FC<MarkdownToolbarProps> = ({
  textareaRef,
  value,
  onChange,
  acquisitionNames = [],
  disabled = false,
}) => {
  const pendingSel = useRef<[number, number] | null>(null);
  const [showAcqMenu, setShowAcqMenu] = useState(false);
  const [showTableGrid, setShowTableGrid] = useState(false);
  const [tableHover, setTableHover] = useState<{ rows: number; cols: number }>({ rows: 0, cols: 0 });
  const TABLE_MAX = 6;

  // Restore the cursor/selection after the parent re-renders with the new value.
  useEffect(() => {
    if (pendingSel.current && textareaRef.current) {
      const [start, end] = pendingSel.current;
      pendingSel.current = null;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(start, end);
    }
  }, [value, textareaRef]);

  const applyEdit = (
    transform: (sel: { start: number; end: number; text: string }) => { value: string; selStart: number; selEnd: number }
  ) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const result = transform({ start, end, text: value.slice(start, end) });
    pendingSel.current = [result.selStart, result.selEnd];
    onChange(result.value);
  };

  const wrap = (before: string, after: string, placeholder = 'text') =>
    applyEdit(({ start, end, text }) => {
      const inner = text || placeholder;
      const newValue = value.slice(0, start) + before + inner + after + value.slice(end);
      const selStart = start + before.length;
      return { value: newValue, selStart, selEnd: selStart + inner.length };
    });

  const prefixLines = (makePrefix: (i: number) => string) =>
    applyEdit(({ start, end }) => {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const block = value.slice(lineStart, end);
      const prefixed = block
        .split('\n')
        .map((line, i) => makePrefix(i) + line)
        .join('\n');
      const newValue = value.slice(0, lineStart) + prefixed + value.slice(end);
      const firstPrefixLen = makePrefix(0).length;
      return { value: newValue, selStart: start + firstPrefixLen, selEnd: end + (prefixed.length - block.length) };
    });

  const insertLink = () =>
    applyEdit(({ start, end, text }) => {
      const label = text || 'link text';
      const snippet = `[${label}](url)`;
      const newValue = value.slice(0, start) + snippet + value.slice(end);
      const urlStart = start + label.length + 3; // past "[label]("
      return { value: newValue, selStart: urlStart, selEnd: urlStart + 3 };
    });

  const insertAcqLink = (name: string) =>
    applyEdit(({ start, end, text }) => {
      const label = text || name;
      const snippet = `[${label}](#acq:${encodeURIComponent(name)})`;
      const newValue = value.slice(0, start) + snippet + value.slice(end);
      const caret = start + snippet.length;
      return { value: newValue, selStart: caret, selEnd: caret };
    });

  const insertTable = (bodyRows: number, cols: number) =>
    applyEdit(({ start }) => {
      const header = '| ' + Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ') + ' |';
      const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
      const rows = Array.from({ length: bodyRows }, () => '| ' + Array.from({ length: cols }, () => '  ').join(' | ') + ' |').join('\n');
      const atLineStart = start === 0 || value[start - 1] === '\n';
      const prefix = atLineStart ? '' : '\n';
      const table = `${prefix}${header}\n${sep}\n${rows}\n`;
      const newValue = value.slice(0, start) + table + value.slice(start);
      const caret = start + prefix.length + 2; // inside first header cell
      return { value: newValue, selStart: caret, selEnd: caret + 'Column 1'.length };
    });

  const btn = 'p-1.5 rounded text-content-secondary hover:text-content-primary hover:bg-surface-secondary disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex items-center gap-0.5 flex-wrap border border-border-secondary rounded-t-lg bg-surface-secondary/50 px-1 py-1">
      <button type="button" className={btn} disabled={disabled} title="Bold" onClick={() => wrap('**', '**', 'bold text')}><Bold className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={disabled} title="Italic" onClick={() => wrap('*', '*', 'italic text')}><Italic className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={disabled} title="Heading" onClick={() => prefixLines(() => '## ')}><Heading className="h-4 w-4" /></button>
      <span className="w-px h-4 bg-border-secondary mx-0.5" />
      <button type="button" className={btn} disabled={disabled} title="Bulleted list" onClick={() => prefixLines(() => '- ')}><List className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={disabled} title="Numbered list" onClick={() => prefixLines((i) => `${i + 1}. `)}><ListOrdered className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={disabled} title="Quote" onClick={() => prefixLines(() => '> ')}><Quote className="h-4 w-4" /></button>
      <span className="w-px h-4 bg-border-secondary mx-0.5" />
      <button type="button" className={btn} disabled={disabled} title="Inline code" onClick={() => wrap('`', '`', 'code')}><Code className="h-4 w-4" /></button>
      <button type="button" className={btn} disabled={disabled} title="Link" onClick={insertLink}><LinkIcon className="h-4 w-4" /></button>

      <div className="relative">
        <button
          type="button"
          className={btn}
          disabled={disabled}
          title="Insert table"
          onClick={() => { setShowTableGrid((s) => !s); setTableHover({ rows: 0, cols: 0 }); }}
        >
          <TableIcon className="h-4 w-4" />
        </button>
        {showTableGrid && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowTableGrid(false)} />
            <div className="absolute left-0 top-full mt-1 z-20 rounded-md border border-border bg-surface-primary shadow-lg p-3 w-max">
              <div
                className="grid gap-1"
                style={{ gridTemplateColumns: `repeat(${TABLE_MAX}, 1.25rem)` }}
                onMouseLeave={() => setTableHover({ rows: 0, cols: 0 })}
              >
                {Array.from({ length: TABLE_MAX }).map((_, r) =>
                  Array.from({ length: TABLE_MAX }).map((_, c) => {
                    const active = r < tableHover.rows && c < tableHover.cols;
                    return (
                      <button
                        key={`${r}-${c}`}
                        type="button"
                        className={`w-5 h-5 border rounded-sm transition-colors ${active ? 'bg-brand-500 border-brand-600' : 'border-border-secondary bg-surface-secondary hover:border-brand-400'}`}
                        onMouseEnter={() => setTableHover({ rows: r + 1, cols: c + 1 })}
                        onClick={() => { insertTable(tableHover.rows, tableHover.cols); setShowTableGrid(false); }}
                      />
                    );
                  })
                )}
              </div>
              <div className="text-xs text-content-tertiary text-center mt-2 whitespace-nowrap">
                {tableHover.rows > 0 ? `${tableHover.rows} × ${tableHover.cols} (+ header)` : 'Pick size'}
              </div>
            </div>
          </>
        )}
      </div>

      {acquisitionNames.length > 0 && (
        <div className="relative">
          <button
            type="button"
            className={`${btn} inline-flex items-center gap-0.5`}
            disabled={disabled}
            title="Link to another acquisition in this schema"
            onClick={() => setShowAcqMenu((s) => !s)}
          >
            <Layers className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
          </button>
          {showAcqMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAcqMenu(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 min-w-[12rem] max-h-64 overflow-auto rounded-md border border-border bg-surface-primary shadow-lg py-1">
                <div className="px-2 py-1 text-[11px] font-medium text-content-tertiary uppercase tracking-wider">Link to acquisition</div>
                {acquisitionNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-sm text-content-secondary hover:bg-surface-secondary hover:text-content-primary truncate"
                    onClick={() => { insertAcqLink(name); setShowAcqMenu(false); }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default MarkdownToolbar;
