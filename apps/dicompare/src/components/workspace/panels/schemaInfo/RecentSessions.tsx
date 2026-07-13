import React, { useState } from 'react';
import { Clock, Trash2, HardDrive, FolderOpen, Loader, Plus } from 'lucide-react';
import { StoredSessionMetadata } from '../../../../services/SessionStorageManager';

interface RecentSessionsProps {
  sessions: StoredSessionMetadata[];
  isLoading: boolean;
  activeSessionId: string | null;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onCreateNew: () => void;
  onClearAll: () => void;
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

const RecentSessions: React.FC<RecentSessionsProps> = ({
  sessions,
  isLoading,
  activeSessionId,
  onLoadSession,
  onDeleteSession,
  onCreateNew,
  onClearAll,
}) => {
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  const handleLoad = async (sessionId: string) => {
    setLoadingSessionId(sessionId);
    try {
      await onLoadSession(sessionId);
    } finally {
      setLoadingSessionId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="mt-8">
        <h3 className="text-sm font-medium text-content-tertiary uppercase tracking-wider mb-3">Recent Sessions</h3>
        <div className="flex items-center justify-center py-6 text-content-tertiary">
          <Loader className="h-4 w-4 animate-spin mr-2" />
          <span className="text-sm">Loading sessions...</span>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-content-tertiary uppercase tracking-wider">Recent Sessions</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={onCreateNew}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border text-content-secondary hover:text-content-primary hover:bg-surface-secondary transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New session
          </button>
          <button
            onClick={onClearAll}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border text-content-secondary hover:text-status-error hover:border-status-error hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear all
          </button>
        </div>
      </div>
      <p className="text-sm text-content-secondary mb-4">
        Your workspace is saved automatically. Open a previous session to continue where you left off.
      </p>
      <div className="space-y-2">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const isLoadingThis = loadingSessionId === session.id;

          return (
            <div
              key={session.id}
              className={`border rounded-lg p-3 transition-colors ${
                isActive
                  ? 'border-brand-300 bg-brand-50/50 dark:border-brand-700 dark:bg-brand-900/10'
                  : 'border-border hover:border-brand-200 dark:hover:border-brand-800'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <FolderOpen className="h-4 w-4 text-brand-500 flex-shrink-0" />
                  <span className="font-medium text-sm text-content-primary truncate">
                    {session.name}
                  </span>
                  {isActive && (
                    <span className="text-xs font-medium text-brand-600 dark:text-brand-400 bg-brand-100 dark:bg-brand-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
                      Active
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                  className="p-1 rounded text-content-tertiary hover:text-status-error hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
                  title="Delete session"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-3 mt-1.5 ml-6 text-xs text-content-tertiary">
                <span>{session.itemCount} {session.itemCount === 1 ? 'acquisition' : 'acquisitions'}</span>
                <span className="flex items-center gap-1">
                  <HardDrive className="h-3 w-3" />
                  {formatStorageSize(session.storageSize)}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </div>

              {!isActive && (
                <div className="mt-2 ml-6">
                  <button
                    onClick={() => handleLoad(session.id)}
                    disabled={isLoadingThis}
                    className="text-xs font-medium px-3 py-1 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {isLoadingThis ? (
                      <>
                        <Loader className="h-3 w-3 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      'Open'
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RecentSessions;
