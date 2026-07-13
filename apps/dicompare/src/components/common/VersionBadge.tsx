import React, { useState } from 'react';
import { VERSION } from '../../version';
import ChangelogModal from './ChangelogModal';

/**
 * The app version rendered as a button that opens the changelog (fetched live
 * from the GitHub releases). Drop-in replacement for the plain version span.
 */
const VersionBadge: React.FC<{ className?: string }> = ({ className }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View changelog"
        className={className ?? 'text-xs font-medium text-content-tertiary opacity-60 hover:opacity-100 hover:text-brand-600 transition-opacity ml-1 cursor-pointer'}
      >
        v{VERSION}
      </button>
      <ChangelogModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default VersionBadge;
