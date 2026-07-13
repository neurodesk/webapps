import React, { useRef, useState } from 'react';
import { Waypoints, Loader, CheckCircle, AlertCircle } from 'lucide-react';
import { Acquisition } from '../../types';
import { useDropZone } from '../../hooks/useDropZone';
import { deriveGradientDescriptorFields } from '../../hooks/useFileProcessing';

interface GradientDropZoneProps {
  acquisition: Acquisition;
  onUpdateAcquisition: (updates: Partial<Acquisition>) => void;
  disabled?: boolean;
}

const getFieldValue = (acq: Acquisition, name: string): any =>
  acq.acquisitionFields?.find(f => (f.keyword || f.name) === name)?.value;

/**
 * Compact drop area for supplementary diffusion gradient files (.dvs, or a
 * .bvec + .bval pair). Dropping a file derives shell/direction descriptors and
 * merges them into the acquisition. Doubles as the status indicator: once
 * descriptors exist it shows a summary of the derived scheme. The raw file is
 * consumed, not stored.
 */
const GradientDropZone: React.FC<GradientDropZoneProps> = ({
  acquisition,
  onUpdateAcquisition,
  disabled = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: FileList) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const fields = await deriveGradientDescriptorFields(acquisition, arr);
      onUpdateAcquisition({ acquisitionFields: fields });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to derive gradient descriptors');
    } finally {
      setBusy(false);
    }
  };

  const dropZone = useDropZone({ onDrop: handleFiles, disabled: disabled || busy });

  // Derived-descriptor summary (persistent indicator).
  const shells = getFieldValue(acquisition, 'NumberOfDiffusionShells');
  const bvalues = getFieldValue(acquisition, 'DiffusionBValues');
  const volumes = getFieldValue(acquisition, 'NumberOfDiffusionVolumes');
  const hasDescriptors = shells !== undefined && Array.isArray(bvalues);

  const containerClasses = `border-2 border-dashed rounded-lg p-3 text-center transition-colors ${
    disabled
      ? 'border-border-secondary bg-surface-tertiary/50 opacity-50 cursor-not-allowed'
      : dropZone.isDragOver
        ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
        : hasDescriptors
          ? 'border-green-400/60 bg-green-50/50 dark:border-green-700/50 dark:bg-green-900/10 cursor-pointer hover:border-brand-400'
          : 'border-border-secondary bg-surface-secondary/50 cursor-pointer hover:border-brand-400'
  }`;

  return (
    <div
      className={containerClasses}
      {...(disabled || busy ? {} : dropZone.handlers)}
      onClick={() => !disabled && !busy && inputRef.current?.click()}
      role="button"
      title="Attach a diffusion gradient file (.dvs, or a .bvec + .bval pair)"
    >
      <input
        ref={inputRef}
        type="file"
        accept=".dvs,.bvec,.bval"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ''; }}
      />

      {busy ? (
        <div className="flex items-center justify-center gap-2 text-content-secondary py-1">
          <Loader className="h-4 w-4 animate-spin" />
          <span className="text-xs font-medium">Deriving gradient descriptors…</span>
        </div>
      ) : hasDescriptors ? (
        <div className="flex items-center justify-center gap-2 text-green-700 dark:text-green-400 py-0.5">
          <CheckCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs font-medium">
            Gradient descriptors derived · {shells} shell{shells === 1 ? '' : 's'}
            {' · b = '}{(bvalues as number[]).join('/')} s/mm²
            {volumes !== undefined ? ` · ${volumes} volumes` : ''}
          </span>
        </div>
      ) : (
        <>
          <Waypoints className={`h-5 w-5 mx-auto mb-1 ${dropZone.isDragOver ? 'text-brand-600' : 'text-content-muted'}`} />
          <p className="text-xs font-medium text-content-secondary">Supplementary files — diffusion gradient</p>
          <p className="text-[11px] text-content-tertiary mt-0.5">
            Drop a <span className="font-mono">.dvs</span> (or <span className="font-mono">.bvec</span> + <span className="font-mono">.bval</span>) to derive shells &amp; directions
          </p>
        </>
      )}

      {error && (
        <div className="flex items-center justify-center gap-1.5 mt-1.5 text-status-error">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="text-[11px]">{error}</span>
        </div>
      )}
    </div>
  );
};

export default GradientDropZone;
