import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Plus, Trash2, Download, Edit2, Brain, ImageIcon, Check, Columns2 } from 'lucide-react';
import { SchemaImage } from '../../types';
import { isVolumeUrl, isFlatImageUrl } from '../../utils/imageHelpers';
import NiivueViewer, { VolumeInfo, ViewMode, VIEW_MODES } from '../viewer/NiivueViewer';
import VolumeThumbnail from '../common/VolumeThumbnail';
import { Niivue } from '@niivue/niivue';
import { Dcm2niix } from '@niivue/dcm2niix';

type SectionId = 'reference' | 'schema' | 'test';

interface Selection {
  section: SectionId;
  index: number;
}

interface ImageManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  images: SchemaImage[];
  onSave?: (images: SchemaImage[]) => void;
  isReadOnly?: boolean;
  dicomFiles?: File[];
  testDicomFiles?: File[];
  initialTab?: SectionId;
  initialSelectedIndex?: number;
  initialMatchFiles?: File[];
}

const selectionEquals = (a: Selection | null, b: Selection | null) =>
  a !== null && b !== null && a.section === b.section && a.index === b.index;

const ImageManagerModal: React.FC<ImageManagerModalProps> = ({
  isOpen,
  onClose,
  title,
  images,
  onSave,
  isReadOnly = false,
  dicomFiles,
  testDicomFiles,
  initialTab,
  initialSelectedIndex,
  initialMatchFiles,
}) => {
  const hasReferenceDicoms = dicomFiles && dicomFiles.length > 0;
  const hasTestDicoms = testDicomFiles && testDicomFiles.length > 0;
  const defaultSection: SectionId = initialTab ?? (hasReferenceDicoms ? 'reference' : 'schema');

  // Primary and compare selections
  const [primary, setPrimary] = useState<Selection>({ section: defaultSection, index: initialSelectedIndex ?? 0 });
  const [compare, setCompare] = useState<Selection | null>(null);

  // Volume discovery state for DICOM sections
  const [refDiscoveredVolumes, setRefDiscoveredVolumes] = useState<VolumeInfo[]>([]);
  const [testDiscoveredVolumes, setTestDiscoveredVolumes] = useState<VolumeInfo[]>([]);

  // Schema images editing state
  const [editedImages, setEditedImages] = useState<SchemaImage[]>(images);
  const lastSavedRef = useRef(images);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // NiiVue sync state for compare mode — use state (not refs) so effects re-trigger
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [sharedViewMode, setSharedViewMode] = useState<ViewMode>('multiplanar');
  const [primaryNv, setPrimaryNv] = useState<Niivue | null>(null);
  const [compareNv, setCompareNv] = useState<Niivue | null>(null);

  const handlePrimaryNvReady = useCallback((nv: Niivue | null) => {
    setPrimaryNv(nv);
  }, []);

  const handleCompareNvReady = useCallback((nv: Niivue | null) => {
    setCompareNv(nv);
  }, []);

  // Set up bidirectional sync when both viewers are ready
  useEffect(() => {
    if (!primaryNv || !compareNv || !syncEnabled || !compare) return;

    try {
      primaryNv.broadcastTo(compareNv, { '2d': true, '3d': true });
      compareNv.broadcastTo(primaryNv, { '2d': true, '3d': true });
    } catch {
      // Ignore if broadcastTo fails
    }

    return () => {
      try {
        primaryNv.broadcastTo([], { '2d': true, '3d': true });
        compareNv.broadcastTo([], { '2d': true, '3d': true });
      } catch {
        // Ignore cleanup errors
      }
    };
  }, [syncEnabled, compare, primaryNv, compareNv]);

  // Resize state
  const [size, setSize] = useState({ width: 1024, height: 0 });
  const resizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const modalRef = useRef<HTMLDivElement>(null);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = modalRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    resizing.current = true;
    resizeStart.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    setSize({
      width: Math.max(480, resizeStart.current.w + dx * 2),
      height: Math.max(320, resizeStart.current.h + dy * 2),
    });
  }, []);

  const onResizePointerUp = useCallback(() => {
    resizing.current = false;
  }, []);

  useEffect(() => {
    setEditedImages(images);
    lastSavedRef.current = images;
  }, [images]);

  useEffect(() => {
    if (isOpen) {
      setPrimary({ section: initialTab ?? (hasReferenceDicoms ? 'reference' : 'schema'), index: initialSelectedIndex ?? 0 });
      setCompare(null);
      setEditingIndex(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Auto-select a volume by converting series files to discover the matching volume name.
  // Step 1: Run dcm2niix on the subset once to discover the NIfTI name.
  const [matchVolumeName, setMatchVolumeName] = useState<string | undefined>();

  useEffect(() => {
    setMatchVolumeName(undefined);
    if (!isOpen || !initialMatchFiles || initialMatchFiles.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const dcm = new Dcm2niix();
        await dcm.init();
        if (cancelled) return;
        const result: File[] = await dcm.input(initialMatchFiles).run();
        if (cancelled) return;
        const nifti = result.find(f => f.name.endsWith('.nii') || f.name.endsWith('.nii.gz'));
        if (nifti && !cancelled) {
          setMatchVolumeName(nifti.name.toLowerCase());
        }
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [isOpen, initialMatchFiles]);

  // Step 2: Once we have the target name and volumes are discovered, pre-select.
  const matchAppliedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) { matchAppliedRef.current = false; return; }
    if (!matchVolumeName || matchAppliedRef.current) return;

    const volumes = initialTab === 'test' ? testDiscoveredVolumes : refDiscoveredVolumes;
    if (volumes.length === 0) return;

    const match = volumes.find(v => v.name.toLowerCase() === matchVolumeName);
    if (match) {
      const section: SectionId = initialTab === 'test' ? 'test' : 'reference';
      setPrimary({ section, index: match.index });
      matchAppliedRef.current = true;
    }
  }, [isOpen, matchVolumeName, initialTab, refDiscoveredVolumes, testDiscoveredVolumes]);

  const saveIfChanged = () => {
    if (onSave && JSON.stringify(editedImages) !== JSON.stringify(lastSavedRef.current)) {
      const cleaned = editedImages.filter(img => img.url.trim() !== '');
      onSave(cleaned);
      lastSavedRef.current = cleaned;
    }
  };

  // Derive schema image state from primary selection
  const selectedSchemaImage = primary.section === 'schema' ? editedImages[primary.index] : null;
  const selectedIsVolume = selectedSchemaImage && selectedSchemaImage.url.trim() && isVolumeUrl(selectedSchemaImage.url);
  const selectedIsFlatImage = selectedSchemaImage && selectedSchemaImage.url.trim() && isFlatImageUrl(selectedSchemaImage.url);

  const selectedVolumeUrls = useMemo(() => {
    if (!selectedSchemaImage || !selectedIsVolume) return undefined;
    const name = selectedSchemaImage.url.split('/').pop() || 'volume.nii.gz';
    return [{ url: selectedSchemaImage.url, name }];
  }, [selectedSchemaImage?.url, selectedIsVolume]);

  // Same for compare selection
  const compareSchemaImage = compare?.section === 'schema' ? editedImages[compare.index] : null;
  const compareIsVolume = compareSchemaImage && compareSchemaImage.url.trim() && isVolumeUrl(compareSchemaImage.url);
  const compareIsFlatImage = compareSchemaImage && compareSchemaImage.url.trim() && isFlatImageUrl(compareSchemaImage.url);

  const compareVolumeUrls = useMemo(() => {
    if (!compareSchemaImage || !compareIsVolume) return undefined;
    const name = compareSchemaImage.url.split('/').pop() || 'volume.nii.gz';
    return [{ url: compareSchemaImage.url, name }];
  }, [compareSchemaImage?.url, compareIsVolume]);

  // Determine if a selection renders via NiiVue
  const isVolumeSelection = (sel: Selection | null): boolean => {
    if (!sel) return false;
    if (sel.section === 'reference' || sel.section === 'test') return true;
    if (sel.section === 'schema') {
      const img = editedImages[sel.index];
      return !!(img && img.url.trim() && isVolumeUrl(img.url));
    }
    return false;
  };

  if (!isOpen) return null;

  const isComparing = compare !== null;
  const bothVolumes = isComparing && isVolumeSelection(primary) && isVolumeSelection(compare);

  const handleClose = () => {
    saveIfChanged();
    onClose();
  };

  const handleSidebarClick = (section: SectionId, index: number, e: React.MouseEvent) => {
    const sel: Selection = { section, index };

    if (e.shiftKey && !selectionEquals(primary, sel)) {
      // Shift+click: set as compare target
      setCompare(sel);
      setEditingIndex(null);
    } else {
      // Normal click: set as primary, clear compare
      setPrimary(sel);
      setCompare(null);
      setEditingIndex(null);
    }
  };

  const handleAdd = () => {
    const newImages = [...editedImages, { url: '', label: '', description: '' }];
    setEditedImages(newImages);
    const newIndex = newImages.length - 1;
    setPrimary({ section: 'schema', index: newIndex });
    setCompare(null);
    setEditingIndex(newIndex);
  };

  const handleRemove = (index: number) => {
    const updated = editedImages.filter((_, i) => i !== index);
    setEditedImages(updated);
    setEditingIndex(null);
    setCompare(null);
    if (primary.section === 'schema') {
      if (primary.index >= updated.length) {
        setPrimary({ section: 'schema', index: Math.max(0, updated.length - 1) });
      }
    }
  };

  const handleUpdate = (index: number, field: keyof SchemaImage, value: string) => {
    const updated = [...editedImages];
    updated[index] = { ...updated[index], [field]: value };
    setEditedImages(updated);
  };

  const handleFinishEditing = () => {
    setEditingIndex(null);
    saveIfChanged();
  };

  const getFilename = (url: string) => {
    try { return url.split('/').pop() || url; } catch { return url; }
  };

  const isSelected = (section: SectionId, index: number) =>
    selectionEquals(primary, { section, index }) || selectionEquals(compare, { section, index });

  const getHighlightClass = (section: SectionId, index: number) => {
    if (selectionEquals(primary, { section, index })) {
      return section === 'test'
        ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-r-2 border-amber-600'
        : 'bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 border-r-2 border-brand-600';
    }
    if (selectionEquals(compare, { section, index })) {
      return 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-r-2 border-purple-600';
    }
    return 'text-content-secondary hover:bg-surface-primary';
  };

  // Render content for a given selection
  const renderContent = (sel: Selection, isActive: boolean, role: 'primary' | 'compare' = 'primary') => {
    const nvReadyHandler = role === 'primary' ? handlePrimaryNvReady : handleCompareNvReady;
    const syncViewProps = isComparing && syncEnabled && bothVolumes ? {
      externalViewMode: sharedViewMode,
      onViewModeChange: setSharedViewMode,
    } : {};

    if (sel.section === 'reference' && hasReferenceDicoms) {
      return (
        <NiivueViewer
          files={dicomFiles}
          active={isActive}
          onVolumesDiscovered={setRefDiscoveredVolumes}
          externalVolumeIndex={refDiscoveredVolumes.length > 0 ? sel.index : undefined}
          onNiivueReady={isComparing ? nvReadyHandler : undefined}
          {...syncViewProps}
        />
      );
    }
    if (sel.section === 'test' && hasTestDicoms) {
      return (
        <NiivueViewer
          files={testDicomFiles}
          active={isActive}
          onVolumesDiscovered={setTestDiscoveredVolumes}
          externalVolumeIndex={testDiscoveredVolumes.length > 0 ? sel.index : undefined}
          onNiivueReady={isComparing ? nvReadyHandler : undefined}
          {...syncViewProps}
        />
      );
    }
    if (sel.section === 'schema') {
      const img = editedImages[sel.index];
      if (!img) return null;
      const imgIsVolume = img.url.trim() && isVolumeUrl(img.url);
      const imgIsFlatImage = img.url.trim() && isFlatImageUrl(img.url);
      const urls = imgIsVolume ? [{ url: img.url, name: img.url.split('/').pop() || 'volume.nii.gz' }] : undefined;

      return (
        <div className="flex-1 min-h-0 flex flex-col">
          {imgIsVolume ? (
            <NiivueViewer
              urls={selectionEquals(sel, primary) ? selectedVolumeUrls : compareVolumeUrls ?? urls}
              active={isActive}
              onNiivueReady={isComparing ? nvReadyHandler : undefined}
              {...syncViewProps}
            />
          ) : imgIsFlatImage ? (
            <div className="flex-1 min-h-0 bg-gray-950 flex items-center justify-center p-4">
              <img
                src={img.url}
                alt={img.label || 'Image'}
                className="max-w-full max-h-full object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0 bg-gray-950 flex items-center justify-center">
              <div className="text-gray-500 text-sm flex flex-col items-center gap-2">
                <ImageIcon className="h-12 w-12" />
                <span>{img.url.trim() ? 'Preview not available' : 'No URL set'}</span>
              </div>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  // Schema image info bar (only for primary schema selection, not in compare mode)
  const renderInfoBar = () => {
    if (primary.section !== 'schema' || !selectedSchemaImage) return null;
    const isEditingCurrent = editingIndex === primary.index;

    if (isEditingCurrent) {
      return (
        <div className="border-t border-border px-4 py-3 flex-shrink-0">
          <div className="space-y-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-content-tertiary font-medium">URL</label>
              <input
                type="url"
                value={selectedSchemaImage.url}
                onChange={(e) => handleUpdate(primary.index, 'url', e.target.value)}
                placeholder="https://example.com/image.nii.gz"
                className="w-full text-sm border border-border-secondary rounded px-2.5 py-1.5 bg-surface-primary text-content-primary focus:outline-none focus:ring-1 focus:ring-brand-500 placeholder:text-content-tertiary"
                autoFocus
              />
              <p className="text-[10px] text-content-tertiary mt-0.5">Supports NIfTI (.nii, .nii.gz), DICOM (.dcm, .IMA), and images (.png, .jpg, .gif, .webp)</p>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-[10px] uppercase tracking-wider text-content-tertiary font-medium">Label</label>
                <input
                  type="text"
                  value={selectedSchemaImage.label || ''}
                  onChange={(e) => handleUpdate(primary.index, 'label', e.target.value)}
                  placeholder="e.g., Sagittal view"
                  className="w-full text-sm border border-border-secondary rounded px-2.5 py-1.5 bg-surface-primary text-content-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] uppercase tracking-wider text-content-tertiary font-medium">Description</label>
                <input
                  type="text"
                  value={selectedSchemaImage.description || ''}
                  onChange={(e) => handleUpdate(primary.index, 'description', e.target.value)}
                  placeholder="Optional description"
                  className="w-full text-sm border border-border-secondary rounded px-2.5 py-1.5 bg-surface-primary text-content-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={handleFinishEditing} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded transition-colors">
                <Check className="h-3 w-3" /> Done
              </button>
              <button onClick={() => handleRemove(primary.index)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800 rounded transition-colors">
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="border-t border-border px-4 py-3 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-content-primary truncate">
              {selectedSchemaImage.label || getFilename(selectedSchemaImage.url) || 'Untitled'}
            </h4>
            {selectedSchemaImage.description && (
              <p className="text-xs text-content-secondary mt-0.5">{selectedSchemaImage.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {selectedSchemaImage.url.trim() && (
              <a href={selectedSchemaImage.url} target="_blank" rel="noopener noreferrer" download className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-content-secondary border border-border-secondary rounded hover:bg-surface-secondary transition-colors">
                <Download className="h-3 w-3" /> Download
              </a>
            )}
            {onSave && (
              <button onClick={() => setEditingIndex(primary.index)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-content-secondary border border-border-secondary rounded hover:bg-surface-secondary transition-colors">
                <Edit2 className="h-3 w-3" /> Edit
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div
        ref={modalRef}
        className="bg-surface-primary rounded-lg overflow-hidden flex flex-col relative"
        style={{
          width: Math.min(size.width, window.innerWidth - 32),
          height: size.height > 0 ? Math.min(size.height, window.innerHeight - 32) : '80vh',
          maxWidth: '95vw',
          maxHeight: '95vh',
        }}
      >
        {/* Header */}
        <div className="px-6 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <h3 className="text-lg font-semibold text-content-primary">{title}</h3>
              <span className="text-sm text-content-tertiary">Images</span>
            </div>
            {isComparing && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
                <Columns2 className="h-3.5 w-3.5 text-purple-600" />
                <span className="text-xs font-medium text-purple-700 dark:text-purple-300">Comparing</span>
                <button
                  onClick={() => setCompare(null)}
                  className="ml-1 p-0.5 text-purple-400 hover:text-purple-600 rounded transition-colors"
                  title="Exit compare mode"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {!isComparing && (
              <span className="text-[10px] text-content-tertiary">Shift+click to compare</span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 text-content-tertiary hover:text-content-secondary rounded-md hover:bg-surface-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body: sidebar + detail */}
        <div className="flex-1 flex min-h-0">
          {/* Sidebar */}
          <div className="w-52 flex-shrink-0 border-r border-border flex flex-col bg-surface-secondary">
            {/* Reference DICOMs */}
            {hasReferenceDicoms && (
              <div className="flex flex-col min-h-0" style={{ flex: refDiscoveredVolumes.length > 0 ? '1 1 0%' : '0 0 auto' }}>
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary border-b border-border bg-surface-secondary flex-shrink-0">
                  Reference DICOMs
                </div>
                <div className="flex-1 overflow-auto">
                  {refDiscoveredVolumes.length > 0 ? (
                    [...refDiscoveredVolumes].sort((a, b) => a.name.localeCompare(b.name)).map((vol) => (
                      <button
                        key={`ref-${vol.index}`}
                        onClick={(e) => handleSidebarClick('reference', vol.index, e)}
                        className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${getHighlightClass('reference', vol.index)}`}
                      >
                        <Brain className="h-3 w-3 flex-shrink-0 text-content-tertiary" />
                        <span className="truncate text-xs">{vol.name}</span>
                      </button>
                    ))
                  ) : (
                    <button
                      onClick={(e) => handleSidebarClick('reference', 0, e)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${getHighlightClass('reference', 0)}`}
                    >
                      Loading volumes...
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Schema Images */}
            <div className="flex flex-col min-h-0" style={{ flex: editedImages.length > 0 || onSave ? '1 1 0%' : '0 0 auto' }}>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary border-b border-border bg-surface-secondary flex-shrink-0 flex items-center justify-between">
                <span>Schema Images</span>
                <div className="flex items-center gap-1.5">
                  {editedImages.length > 0 && <span className="text-content-muted">{editedImages.length}</span>}
                  {onSave && (
                    <button
                      onClick={handleAdd}
                      className="p-0.5 text-brand-600 hover:text-brand-700 transition-colors"
                      title="Add image"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {editedImages.map((image, index) => (
                  <div
                    key={`schema-${index}`}
                    className={`group w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors cursor-pointer ${getHighlightClass('schema', index)}`}
                    onClick={(e) => handleSidebarClick('schema', index, e)}
                  >
                    <div className="w-6 h-6 rounded border border-border-secondary bg-surface-primary flex-shrink-0 flex items-center justify-center overflow-hidden">
                      {image.url.trim() && isFlatImageUrl(image.url) ? (
                        <img src={image.url} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ) : image.url.trim() && isVolumeUrl(image.url) ? (
                        <Brain className="h-3 w-3 text-content-tertiary" />
                      ) : (
                        <ImageIcon className="h-3 w-3 text-content-tertiary" />
                      )}
                    </div>
                    <span className="truncate text-xs flex-1">
                      {image.label || getFilename(image.url) || `Image ${index + 1}`}
                    </span>
                    {onSave && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemove(index); }}
                        className="p-0.5 text-content-muted hover:text-red-600 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                        title="Delete image"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
                {editedImages.length === 0 && !onSave && (
                  <div className="px-3 py-2 text-xs text-content-tertiary italic">None</div>
                )}
              </div>
            </div>

            {/* Test DICOMs */}
            {hasTestDicoms && (
              <div className="flex flex-col min-h-0" style={{ flex: testDiscoveredVolumes.length > 0 ? '1 1 0%' : '0 0 auto' }}>
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 border-b border-border bg-surface-secondary flex-shrink-0">
                  Test DICOMs
                </div>
                <div className="flex-1 overflow-auto">
                  {testDiscoveredVolumes.length > 0 ? (
                    [...testDiscoveredVolumes].sort((a, b) => a.name.localeCompare(b.name)).map((vol) => (
                      <button
                        key={`test-${vol.index}`}
                        onClick={(e) => handleSidebarClick('test', vol.index, e)}
                        className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${getHighlightClass('test', vol.index)}`}
                      >
                        <Brain className="h-3 w-3 flex-shrink-0 text-content-tertiary" />
                        <span className="truncate text-xs">{vol.name}</span>
                      </button>
                    ))
                  ) : (
                    <button
                      onClick={(e) => handleSidebarClick('test', 0, e)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${getHighlightClass('test', 0)}`}
                    >
                      Loading volumes...
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Detail area */}
          <div className="flex-1 flex flex-col min-w-0">
            {isComparing ? (
              /* Compare mode: sync bar on top, side by side below */
              <>
                {/* Sync controls bar — only when both sides are volumes */}
                {bothVolumes && <div className="border-b border-border px-4 py-1.5 flex-shrink-0 flex items-center gap-3 bg-surface-secondary">
                  <label className="flex items-center gap-1.5 text-xs text-content-secondary cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={syncEnabled}
                      onChange={(e) => setSyncEnabled(e.target.checked)}
                      className="rounded border-border-secondary text-brand-600 focus:ring-brand-500 h-3.5 w-3.5"
                    />
                    Sync
                  </label>
                  {syncEnabled && (
                    <>
                      <div className="w-px h-4 bg-border-secondary" />
                      <div className="flex items-center gap-0.5 bg-surface-primary rounded-md p-0.5 border border-border-secondary">
                        {VIEW_MODES.map(({ key, label }) => (
                          <button
                            key={key}
                            onClick={() => setSharedViewMode(key)}
                            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                              sharedViewMode === key
                                ? 'bg-brand-600 text-white'
                                : 'text-content-secondary hover:text-content-primary hover:bg-surface-primary'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>}
                <div className="flex-1 flex min-h-0">
                  <div className="flex-1 flex flex-col min-w-0 border-r border-border">
                    {renderContent(primary, true, 'primary')}
                  </div>
                  <div className="flex-1 flex flex-col min-w-0">
                    {renderContent(compare!, true, 'compare')}
                  </div>
                </div>
              </>
            ) : (
              /* Normal mode */
              <>
                <div className="flex-1 flex flex-col min-h-0">
                  {renderContent(primary, true, 'primary')}
                </div>
                {renderInfoBar()}
              </>
            )}

            {/* Empty state — only when nothing meaningful is selected */}
            {!isComparing && primary.section === 'schema' && !selectedSchemaImage && editedImages.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-content-tertiary">
                <div className="text-center">
                  <ImageIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm mb-2">No images yet</p>
                  {onSave && (
                    <button onClick={handleAdd} className="text-sm text-brand-600 hover:text-brand-700 underline">
                      Add a schema image
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Resize handle */}
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10 flex items-end justify-end p-0.5 touch-none"
          title="Drag to resize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-content-tertiary">
            <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
};

export default ImageManagerModal;
