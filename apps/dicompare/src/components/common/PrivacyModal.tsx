import React from 'react';
import { Shield } from 'lucide-react';
import Modal from './Modal';

interface PrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PrivacyModal: React.FC<PrivacyModalProps> = ({ isOpen, onClose }) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Privacy" size="md">
        {/* Body */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {/* Highlight box */}
          <div className="flex items-start gap-4 bg-brand-50 dark:bg-brand-950/30 border border-brand-500 rounded-lg p-4">
            <Shield className="h-8 w-8 text-brand-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-brand-700 dark:text-brand-400">Your data never leaves your device.</p>
              <p className="text-sm text-content-secondary mt-1 leading-relaxed">
                dicompare runs entirely in your web browser. All processing occurs locally on your machine.
              </p>
            </div>
          </div>

          {/* What this means */}
          <div>
            <h4 className="text-sm font-semibold text-content-primary mb-2">What this means</h4>
            <ul className="text-sm text-content-secondary leading-relaxed space-y-1.5 list-disc pl-5">
              <li>No data is uploaded to any server or cloud service</li>
              <li>No internet connection is required after the page loads</li>
              <li>Sensitive patient data remains on your computer at all times</li>
              <li>There is no need to anonymise, deface, or otherwise de-identify your data before use</li>
            </ul>
          </div>

          {/* How it works */}
          <div>
            <h4 className="text-sm font-semibold text-content-primary mb-2">How it works</h4>
            <p className="text-sm text-content-secondary leading-relaxed">
              dicompare uses Pyodide to run Python-based DICOM validation directly in the browser via WebAssembly. Your files are read into browser memory, processed locally, and results are displayed without any network transfer.
            </p>
          </div>

          {/* Third-party services */}
          <div>
            <h4 className="text-sm font-semibold text-content-primary mb-2">Third-party services</h4>
            <p className="text-sm text-content-secondary leading-relaxed">
              dicompare never sends your DICOM files or their metadata anywhere. To run, the page downloads the Pyodide runtime from cdn.jsdelivr.net and Python packages from PyPI, and it counts page views with Cloudflare Web Analytics, which sets no cookies. None of these requests contains data from your files.
            </p>
          </div>
        </div>
    </Modal>
  );
};

export default PrivacyModal;
