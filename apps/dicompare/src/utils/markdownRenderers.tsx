import React from 'react';
import { Layers } from 'lucide-react';

const ACQ_PREFIX = '#acq:';

/**
 * Build the `components` object for ReactMarkdown so that internal acquisition
 * links (`[name](#acq:name)`) render as click-to-navigate chips resolved against
 * the current schema, while ordinary links open externally.
 *
 * @param onAcquisitionClick Called with the target acquisition name when an
 *   internal acquisition link is clicked. If omitted, the link renders but does
 *   nothing on click (e.g. in a static preview).
 */
export function markdownComponents(onAcquisitionClick?: (name: string) => void) {
  return {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href && href.startsWith(ACQ_PREFIX)) {
        const name = decodeURIComponent(href.slice(ACQ_PREFIX.length));
        return (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onAcquisitionClick?.(name);
            }}
            className="inline-flex items-baseline gap-0.5 text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 underline decoration-dotted underline-offset-2"
            title={`Go to acquisition "${name}"`}
          >
            <Layers className="h-3 w-3 self-center" />
            {children}
          </button>
        );
      }
      return (
        <a
          href={href}
          className="text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
  };
}
