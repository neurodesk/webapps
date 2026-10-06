import React from 'react';
import { Info } from 'lucide-react';
import CustomTooltip from '../common/CustomTooltip';

/**
 * Marks a constraint that carries a note, revealing the rationale on hover.
 * Notes are documentation only — they never affect validation.
 */
export const FieldNoteMarker: React.FC<{ note: string }> = ({ note }) => {
  // A note that is still being typed can be all whitespace; that is not a note.
  const trimmed = (note || '').trim();
  if (!trimmed) return null;

  return (
    <CustomTooltip content={trimmed} position="top" delay={100} className="flex-shrink-0 leading-none">
      <Info
        className="h-3 w-3 text-content-muted hover:text-brand-600 cursor-help"
        aria-label="Has a note"
      />
    </CustomTooltip>
  );
};
