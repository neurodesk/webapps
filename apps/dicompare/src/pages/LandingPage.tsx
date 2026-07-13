import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Github, ShieldCheck, Layers, Upload, FileCheck, Printer, Lock, ArrowRight, Quote, Shield, BookOpen, LayoutGrid } from 'lucide-react';
import ThemeToggle from '../components/common/ThemeToggle';
import CitationModal from '../components/common/CitationModal';
import PrivacyModal from '../components/common/PrivacyModal';
import VersionBadge from '../components/common/VersionBadge';

const LandingPage: React.FC = () => {
  const [showCitation, setShowCitation] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-brand-50 to-surface-primary dark:from-surface dark:to-surface">
      {/* Header */}
      <header className="bg-surface-primary shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <Link to="/" className="flex items-center hover:opacity-80 transition-opacity">
            <ShieldCheck className="h-8 w-8 text-brand-600 mr-3" />
            <h1 className="text-2xl font-bold text-content-primary">dicompare</h1>
          </Link>
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
              href="https://neurodesk.org/getting-started/hosted/webapps/"
              target="_blank"
              rel="noopener noreferrer"
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

      {/* Main Content */}
      <main className="flex-1">
        {/* Hero Section */}
        <div className="relative overflow-hidden bg-surface">
          {/* Background Image - Light mode version */}
          <div
            className="absolute inset-0 bg-auto bg-right-top bg-no-repeat dark:hidden"
            style={{ backgroundImage: 'url(./hero-light.png)', backgroundSize: 'auto 120%' }}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-surface via-surface/70 to-transparent" />
          </div>
          {/* Background Image - Dark mode version */}
          <div
            className="absolute inset-0 bg-auto bg-right-top bg-no-repeat hidden dark:block"
            style={{ backgroundImage: 'url(./hero.png)', backgroundSize: 'auto 120%' }}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-surface via-surface/70 to-transparent" />
          </div>

          {/* Content */}
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20">
            <div className="max-w-2xl">
              <h2 className="text-4xl md:text-5xl font-bold text-content-primary mb-6 drop-shadow-sm">
                MRI Protocol Validation for Global Collaboration
              </h2>
              <p className="text-xl text-content-secondary mb-10 drop-shadow-sm">
                dicompare validates your DICOMs against community protocols and standards. You can also build and share your own schemas for multi-site studies or the community.
              </p>

              {/* CTAs */}
              <div className="flex flex-wrap items-center gap-4">
                <Link
                  to="/workspace"
                  className="inline-flex items-center px-6 py-3 text-lg font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors shadow-lg hover:shadow-xl"
                >
                  <Layers className="h-5 w-5 mr-2" />
                  Open Workspace
                  <ArrowRight className="h-5 w-5 ml-2" />
                </Link>
                <Link
                  to="/schema"
                  className="inline-flex items-center px-6 py-3 text-lg font-medium text-content-primary bg-surface-primary border border-border rounded-lg hover:bg-surface-secondary transition-colors shadow-sm hover:shadow-md"
                >
                  <BookOpen className="h-5 w-5 mr-2" />
                  Schema Library
                </Link>
              </div>

              {/* Privacy Badge */}
              <p className="mt-5 text-sm text-content-secondary">
                <Lock className="h-4 w-4 inline mr-1.5 -mt-0.5" />
                100% browser-based — your data never leaves your computer
              </p>
            </div>
          </div>
        </div>

      {/* How It Works */}
      <div className="bg-surface-primary border-y border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <h3 className="text-xl font-semibold text-content-primary text-center mb-8">How It Works</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            <div className="text-center">
              <div className="w-12 h-12 bg-brand-100 dark:bg-brand-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <Upload className="h-6 w-6 text-brand-600" />
              </div>
              <h4 className="font-medium text-content-primary mb-1">1. Load Data or Schema</h4>
              <p className="text-sm text-content-secondary">
                Load your own data or select from the library of community protocols
              </p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-brand-100 dark:bg-brand-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <FileCheck className="h-6 w-6 text-brand-600" />
              </div>
              <h4 className="font-medium text-content-primary mb-1">2. Compare & Validate</h4>
              <p className="text-sm text-content-secondary">
                Check data compliance or edit validation schema to suit your study
              </p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-brand-100 dark:bg-brand-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <Printer className="h-6 w-6 text-brand-600" />
              </div>
              <h4 className="font-medium text-content-primary mb-1">3. Export & Share</h4>
              <p className="text-sm text-content-secondary">
                Export sharable JSON schema representing your study, or publish data compliance reports
              </p>
            </div>
          </div>
        </div>
      </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-surface-primary">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center text-sm text-content-tertiary">
              <ShieldCheck className="h-4 w-4 mr-2 text-brand-600" />
              dicompare — Open source under MIT License
            </div>
            <div className="flex items-center gap-6 text-sm">
              <a
                href="https://github.com/astewartau/dicompare-web"
                target="_blank"
                rel="noopener noreferrer"
                className="text-content-secondary hover:text-content-primary transition-colors"
              >
                GitHub
              </a>
              <a
                href="https://github.com/astewartau/dicompare-web/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="text-content-secondary hover:text-content-primary transition-colors"
              >
                Report Issue
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
