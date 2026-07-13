import React, { useEffect, useState } from 'react';
import { X, Loader, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { VERSION } from '../../version';

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Release {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  body: string | null;
  html_url: string;
}

const RELEASES_API = 'https://api.github.com/repos/astewartau/dicompare-web/releases?per_page=30';
const RELEASES_PAGE = 'https://github.com/astewartau/dicompare-web/releases';

// Cache across opens within a session so we don't refetch (GitHub's anonymous
// API is rate-limited to 60 requests/hour per IP).
let cachedReleases: Release[] | null = null;

// Compact markdown styling for release notes (independent of the typography plugin).
const mdComponents = {
  h1: ({ children }: any) => <h3 className="text-base font-semibold text-content-primary mt-3 mb-1.5">{children}</h3>,
  h2: ({ children }: any) => <h4 className="text-sm font-semibold text-content-primary mt-3 mb-1.5">{children}</h4>,
  h3: ({ children }: any) => <h5 className="text-sm font-semibold text-content-secondary mt-2 mb-1">{children}</h5>,
  p: ({ children }: any) => <p className="text-sm text-content-secondary mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc list-inside mb-2 space-y-0.5 text-sm text-content-secondary">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal list-inside mb-2 space-y-0.5 text-sm text-content-secondary">{children}</ol>,
  li: ({ children }: any) => <li className="ml-1">{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold text-content-primary">{children}</strong>,
  code: ({ children }: any) => <code className="bg-surface-secondary text-brand-600 dark:text-brand-400 px-1 py-0.5 rounded text-xs font-mono">{children}</code>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 dark:text-brand-400 underline">{children}</a>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

const ChangelogModal: React.FC<ChangelogModalProps> = ({ isOpen, onClose }) => {
  const [releases, setReleases] = useState<Release[] | null>(cachedReleases);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || releases) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 403 ? 'GitHub rate limit reached — try again later.' : `HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Release[]) => {
        if (cancelled) return;
        cachedReleases = data;
        setReleases(data);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load changelog.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, releases]);

  if (!isOpen) return null;

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-surface-primary rounded-lg shadow-xl max-w-lg w-full max-h-[75vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-content-primary">Changelog</h3>
            <p className="text-xs text-content-tertiary">You're on v{VERSION}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-content-tertiary hover:text-content-primary hover:bg-surface-secondary rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10 text-content-tertiary">
              <Loader className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm">Loading releases…</span>
            </div>
          )}

          {error && !loading && (
            <div className="text-sm text-content-secondary">
              <p className="mb-2">{error}</p>
              <a href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 underline">
                View releases on GitHub <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}

          {!loading && !error && releases && releases.length === 0 && (
            <p className="text-sm text-content-tertiary">No releases found.</p>
          )}

          {!loading && !error && releases && releases.map((rel) => (
            <div key={rel.tag_name} className="mb-6 last:mb-0">
              <div className="flex items-baseline gap-2 mb-1 pb-1 border-b border-border">
                <a href={rel.html_url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                  {rel.name || rel.tag_name}
                </a>
                {rel.published_at && <span className="text-xs text-content-tertiary">{fmtDate(rel.published_at)}</span>}
              </div>
              {rel.body?.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{rel.body}</ReactMarkdown>
              ) : (
                <p className="text-sm text-content-tertiary italic">No release notes.</p>
              )}
            </div>
          ))}
        </div>

        <div className="px-6 py-3 border-t border-border flex-shrink-0 text-right">
          <a href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-content-tertiary hover:text-content-primary">
            All releases on GitHub <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
};

export default ChangelogModal;
