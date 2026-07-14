import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Github, Layers, Quote, Shield, LayoutGrid } from 'lucide-react';
import { WorkspaceProviders } from '../contexts/WorkspaceProviders';
import { PyodideProvider } from '../contexts/PyodideContext';
import ThemeToggle from '../components/common/ThemeToggle';
import CitationModal from '../components/common/CitationModal';
import PrivacyModal from '../components/common/PrivacyModal';
import VersionBadge from '../components/common/VersionBadge';
import UnifiedWorkspace from '../components/workspace/UnifiedWorkspace';
import PyodideLoadingNotification from '../components/common/PyodideLoadingNotification';

const UnifiedWorkspacePage: React.FC = () => {
  const [showCitation, setShowCitation] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  return (
    <PyodideProvider>
      <WorkspaceProviders>
        <div className="min-h-screen bg-surface">
          {/* Header */}
          <header className="bg-surface-primary shadow-sm">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
              <div className="flex items-center">
                <Link to="/" className="flex items-center hover:opacity-80 transition-opacity">
                  <ShieldCheck className="h-8 w-8 text-brand-600 mr-2" />
                  <span className="text-xl font-bold text-content-primary">dicompare</span>
                </Link>
                <span className="mx-4 text-content-muted">/</span>
                <Layers className="h-6 w-6 text-brand-600 mr-2" />
                <h1 className="text-xl font-semibold text-content-secondary">Workspace</h1>
              </div>
              <div className="flex items-center gap-1">
                <ThemeToggle />
                <button
                  onClick={() => setShowPrivacy(true)}
                  className="inline-flex items-center gap-1.5 px-2 py-2 rounded-lg text-sm text-content-secondary hover:text-content-primary hover:bg-surface-secondary transition-colors"
                  title="Privacy"
                >
                  <Shield className="h-5 w-5" />
                  <span>Privacy</span>
                </button>
                <button
                  onClick={() => setShowCitation(true)}
                  className="inline-flex items-center gap-1.5 px-2 py-2 rounded-lg text-sm text-content-secondary hover:text-content-primary hover:bg-surface-secondary transition-colors"
                  title="Cite dicompare"
                >
                  <Quote className="h-5 w-5" />
                  <span>Cite</span>
                </button>
                <a
                  href={`${import.meta.env.BASE_URL}../`}
                  className="inline-flex items-center gap-1.5 px-2 py-2 rounded-lg text-sm text-content-secondary hover:text-content-primary hover:bg-surface-secondary transition-colors"
                  title="More Neurodesk web apps"
                >
                  <LayoutGrid className="h-5 w-5" />
                  <span>More Apps</span>
                </a>
                <a
                  href="https://github.com/astewartau/dicompare-web"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2 py-2 rounded-lg text-sm text-content-secondary hover:text-content-primary hover:bg-surface-secondary transition-colors"
                >
                  <Github className="h-5 w-5" />
                  <span>GitHub</span>
                </a>
                <VersionBadge />
              </div>
            </div>
          </header>
          <CitationModal isOpen={showCitation} onClose={() => setShowCitation(false)} />
          <PrivacyModal isOpen={showPrivacy} onClose={() => setShowPrivacy(false)} />

          {/* Content */}
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <UnifiedWorkspace />
          </div>

          {/* Pyodide Loading Notification */}
          <PyodideLoadingNotification />
        </div>
      </WorkspaceProviders>
    </PyodideProvider>
  );
};

export default UnifiedWorkspacePage;
