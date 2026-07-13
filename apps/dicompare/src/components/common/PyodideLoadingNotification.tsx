import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertCircle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { usePyodide } from '../../contexts/PyodideContext';

const PyodideLoadingNotification: React.FC = () => {
  const { status } = usePyodide();
  const [dismissed, setDismissed] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Show success message briefly when ready
  useEffect(() => {
    if (status.isReady && !dismissed) {
      setShowSuccess(true);
      const timer = setTimeout(() => {
        setShowSuccess(false);
        setDismissed(true);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [status.isReady, dismissed]);

  // Don't show if dismissed or not loading/ready
  if (dismissed || (!status.isLoading && !showSuccess && !status.error)) {
    return null;
  }

  const getIcon = () => {
    if (status.error) {
      return <AlertCircle className="h-5 w-5 text-red-500" />;
    }
    if (status.isReady || showSuccess) {
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    }
    return <Loader2 className="h-5 w-5 text-brand-500 animate-spin" />;
  };

  const getMessage = () => {
    if (status.error) {
      return 'Failed to load Python environment';
    }
    if (status.isReady || showSuccess) {
      return 'Python environment ready';
    }
    return status.currentOperation || 'Loading Python environment...';
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className={`
        bg-surface-primary border border-border rounded-lg shadow-lg
        transition-all duration-200 ease-in-out
        ${minimized ? 'w-auto' : 'w-80'}
      `}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            {getIcon()}
            <span className="text-sm font-medium text-content-primary">
              {minimized ? (status.isLoading ? `${Math.round(status.progress)}%` : 'Ready') : 'Python Environment'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMinimized(!minimized)}
              className="p-1 text-content-tertiary hover:text-content-secondary rounded"
            >
              {minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {(status.isReady || status.error) && (
              <button
                onClick={() => setDismissed(true)}
                className="p-1 text-content-tertiary hover:text-content-secondary rounded"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Content - only show when not minimized */}
        {!minimized && (
          <div className="px-3 py-2">
            <p className="text-xs text-content-secondary mb-2">
              {getMessage()}
            </p>

            {/* Progress bar */}
            {status.isLoading && (
              <div className="w-full bg-surface-secondary rounded-full h-1.5">
                <div
                  className="bg-brand-500 h-1.5 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${status.progress}%` }}
                />
              </div>
            )}

            {/* Error details */}
            {status.error && (
              <p className="text-xs text-red-500 mt-1">
                {status.error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PyodideLoadingNotification;
