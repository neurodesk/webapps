import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Upload, Library, FolderOpen, Trash2, Download, FileText, List, ChevronDown, ChevronUp, X, Tag, Check, Minus, Search, GripVertical, BookOpen, FlaskConical, Link2, ExternalLink } from 'lucide-react';
import { UnifiedSchema } from '../../hooks/useSchemaService';
import { useSchemaContext } from '../../contexts/SchemaContext';
import { Acquisition, AcquisitionSelection } from '../../types';
import DeleteConfirmModal from './DeleteConfirmModal';
import { DraggableSchema, DraggableAcquisition } from './DraggableComponents';
import { isAnalysisTag, getAnalysisTagDisplayName, splitTagsWithCounts } from '../../utils/tagUtils';
import { fetchExternalSchema } from '../../utils/externalSchemaFetch';

interface AcquisitionScore {
  schemaId: string;
  acquisitionIndex: number;
  score: number;
  passCount: number;
  failCount: number;
  totalCount: number;
}

interface UnifiedSchemaSelectorProps {
  // Data
  librarySchemas: UnifiedSchema[];
  uploadedSchemas: UnifiedSchema[];

  // Selection behavior
  selectionMode: 'schema' | 'acquisition';

  // Callbacks
  onSchemaSelect?: (schemaId: string) => void;
  onAcquisitionSelect?: (schemaId: string, acquisitionIndex: number) => void;
  onSchemaUpload?: (file: File) => void;
  onSchemaDownload?: (schemaId: string) => void;

  // Multi-select mode (for selecting multiple acquisitions)
  multiSelectMode?: boolean;
  selectedAcquisitions?: AcquisitionSelection[];
  onAcquisitionToggle?: (selection: AcquisitionSelection) => void;

  // UI Options
  expandable?: boolean;
  selectedSchemaId?: string;

  // Utility
  getSchemaContent: (schemaId: string) => Promise<string | null>;

  // Drag-and-drop support (uses dnd-kit - must be used within a DndContext)
  enableDragDrop?: boolean;

  // README support
  onSchemaReadmeClick?: (schemaId: string, schemaName: string) => void;
  onAcquisitionReadmeClick?: (schemaId: string, schemaName: string, acquisitionIndex: number, acquisitionName: string) => void;

  // Edit support (load schema into workspace for editing)
  onSchemaEdit?: (schemaId: string) => void;

  // Acquisition scores for sorting/display
  acquisitionScores?: (schemaId: string, acquisitionIndex: number) => AcquisitionScore | undefined;

  // Open schema page (replaces copy link when provided)
  onOpenSchema?: (schemaId: string) => void;

  // Height constraint (for modal usage)
  maxHeight?: string;
}

const UnifiedSchemaSelector: React.FC<UnifiedSchemaSelectorProps> = ({
  librarySchemas,
  uploadedSchemas,
  selectionMode,
  onSchemaSelect,
  onAcquisitionSelect,
  onSchemaUpload,
  onSchemaDownload,
  multiSelectMode = false,
  selectedAcquisitions = [],
  onAcquisitionToggle,
  expandable = true,
  selectedSchemaId,
  getSchemaContent,
  enableDragDrop = false,
  onSchemaReadmeClick,
  onAcquisitionReadmeClick,
  onSchemaEdit,
  acquisitionScores,
  onOpenSchema,
  maxHeight
}) => {
  const { deleteSchema, fullAcquisitionsCache, loadFullAcquisitions, isAcquisitionsLoading } = useSchemaContext();

  // Filter state (replaces tab-based navigation)
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showLibrary, setShowLibrary] = useState(true);
  const [showCustom, setShowCustom] = useState(true);
  const [regularTagSearch, setRegularTagSearch] = useState('');
  const [analysisTagSearch, setAnalysisTagSearch] = useState('');

  // UI state
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [dragActive, setDragActive] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState<Set<string>>(new Set());
  const [urlInput, setUrlInput] = useState('');
  const [urlImporting, setUrlImporting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const handleUrlImport = async () => {
    const url = urlInput.trim();
    if (!url || !onSchemaUpload) return;
    setUrlImporting(true);
    setUrlError(null);
    try {
      const text = await fetchExternalSchema(url);
      const base = url.split('/').pop()?.split('?')[0] || 'schema.json';
      const filename = base.endsWith('.json') ? base : `${base}.json`;
      await onSchemaUpload(new File([text], filename, { type: 'application/json' }));
      setUrlInput('');
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : 'Failed to import schema from URL');
    } finally {
      setUrlImporting(false);
    }
  };
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; schemaId: string; schemaName: string }>({
    isOpen: false,
    schemaId: '',
    schemaName: ''
  });
  const [showNonMatchingFor, setShowNonMatchingFor] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'nested' | 'flat'>('flat');
  const [copiedSchemaId, setCopiedSchemaId] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copySchemaLink = (schemaId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}${import.meta.env.BASE_URL}schema/${schemaId}`;
    navigator.clipboard.writeText(url);
    setCopiedSchemaId(schemaId);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedSchemaId(null), 2000);
  };

  // Use the context's cache for acquisitions
  const schemaAcquisitions = fullAcquisitionsCache;

  // Combine all schemas with source indicator
  const allSchemas = useMemo(() => [
    ...librarySchemas.map(s => ({ ...s, source: 'library' as const })),
    ...uploadedSchemas.map(s => ({ ...s, source: 'uploaded' as const }))
  ], [librarySchemas, uploadedSchemas]);

  // Helper function to check if all keywords match a schema (used for nested view)
  const schemaMatchesKeywords = (schema: UnifiedSchema, keywords: string[]): boolean => {
    // Build searchable text from schema name and description
    const schemaText = `${schema.name} ${schema.description || ''}`.toLowerCase();

    // Build searchable text from all acquisitions (names, descriptions, and tags)
    const acquisitionTexts = schema.acquisitions?.map(acq =>
      `${acq.protocolName || ''} ${acq.seriesDescription || ''} ${(acq.tags || []).join(' ')}`
    ).join(' ').toLowerCase() || '';

    const combinedText = `${schemaText} ${acquisitionTexts}`;

    // All keywords must match somewhere in the combined text
    return keywords.every(keyword => combinedText.includes(keyword));
  };

  // Helper function to check if all keywords match an individual acquisition (used for flat view)
  const acquisitionMatchesKeywords = (
    schema: UnifiedSchema,
    acqIndex: number,
    keywords: string[]
  ): boolean => {
    const acq = schema.acquisitions?.[acqIndex];
    if (!acq) return false;

    // Build searchable text from this specific acquisition
    const acquisitionText = `${acq.protocolName || ''} ${acq.seriesDescription || ''} ${(acq.tags || []).join(' ')}`.toLowerCase();

    // Also include schema name/description so you can search for "MS FLAIR" and find FLAIR acquisitions in MS schemas
    const schemaText = `${schema.name} ${schema.description || ''}`.toLowerCase();
    const combinedText = `${schemaText} ${acquisitionText}`;

    // All keywords must match somewhere in the combined text for this acquisition
    return keywords.every(keyword => combinedText.includes(keyword));
  };

  // Filter schemas based on search, tags, and source toggles
  const filteredSchemas = useMemo(() => {
    let schemas = allSchemas;

    // Filter by source
    schemas = schemas.filter(s =>
      (showLibrary && s.source === 'library') ||
      (showCustom && s.source === 'uploaded')
    );

    // Filter by search query (keyword-based - all keywords must match)
    if (searchQuery.trim()) {
      const keywords = searchQuery.toLowerCase().split(/\s+/).filter(k => k.length > 0);
      schemas = schemas.filter(s => schemaMatchesKeywords(s, keywords));
    }

    // Filter by selected tags (AND logic - show schemas where at least one acquisition has ALL selected tags)
    if (selectedTags.length > 0) {
      schemas = schemas.filter(s => {
        // Check if at least one acquisition has ALL selected tags (acquisition-level tags only)
        return s.acquisitions?.some((acq) => {
          const acqTags = acq.tags || [];
          return selectedTags.every(tag => acqTags.includes(tag));
        }) || false;
      });
    }

    return schemas;
  }, [allSchemas, showLibrary, showCustom, searchQuery, selectedTags]);

  // Get all unique tags with counts (counting acquisitions, not schemas)
  const tagsWithCounts = useMemo(() => {
    // Use schemas filtered by source and search, but not by tags
    let schemasForTags = allSchemas;

    // Filter by source
    schemasForTags = schemasForTags.filter(s =>
      (showLibrary && s.source === 'library') ||
      (showCustom && s.source === 'uploaded')
    );

    // Filter by search query (keyword-based)
    if (searchQuery.trim()) {
      const keywords = searchQuery.toLowerCase().split(/\s+/).filter(k => k.length > 0);
      schemasForTags = schemasForTags.filter(s => schemaMatchesKeywords(s, keywords));
    }

    const tagCounts = new Map<string, number>();

    schemasForTags.forEach(schema => {
      // Only count acquisition-level tags (schema-level tags don't exist per metaschema)
      if (schema.acquisitions) {
        schema.acquisitions.forEach(acq => {
          const acqTags = acq.tags || [];
          acqTags.forEach(tag => {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          });
        });
      }
    });

    return Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
  }, [allSchemas, showLibrary, showCustom, searchQuery]);

  // Split tags into regular and analysis categories
  const { regularTagsWithCounts, analysisTagsWithCounts } = useMemo(() => {
    return splitTagsWithCounts(tagsWithCounts);
  }, [tagsWithCounts]);

  // Filter tags by search
  const filteredRegularTags = useMemo(() => {
    if (!regularTagSearch.trim()) return regularTagsWithCounts;
    const search = regularTagSearch.toLowerCase();
    return regularTagsWithCounts.filter(({ tag }) => tag.toLowerCase().includes(search));
  }, [regularTagsWithCounts, regularTagSearch]);

  const filteredAnalysisTags = useMemo(() => {
    if (!analysisTagSearch.trim()) return analysisTagsWithCounts;
    const search = analysisTagSearch.toLowerCase();
    return analysisTagsWithCounts.filter(({ tag }) =>
      getAnalysisTagDisplayName(tag).toLowerCase().includes(search)
    );
  }, [analysisTagsWithCounts, analysisTagSearch]);

  // Toggle a tag in the selected tags list
  const toggleTag = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  // Toggle showing non-matching acquisitions for a schema
  const toggleShowNonMatching = (schemaId: string) => {
    setShowNonMatchingFor(prev => {
      const newSet = new Set(prev);
      if (newSet.has(schemaId)) newSet.delete(schemaId);
      else newSet.add(schemaId);
      return newSet;
    });
  };

  // Auto-expand schemas when tag filter is applied
  useEffect(() => {
    if (selectedTags.length > 0) {
      const schemaIds = filteredSchemas.map(s => s.id);
      setExpandedSchemas(new Set(schemaIds));
      // Also reset the non-matching visibility when filter changes
      setShowNonMatchingFor(new Set());
    }
  }, [selectedTags.join(',')]);

  // Load acquisitions for expanded schemas
  useEffect(() => {
    expandedSchemas.forEach(id => {
      loadSchemaAcquisitions(id);
    });
  }, [expandedSchemas]);

  // Load all acquisitions when in flat view mode (load from all source-filtered schemas, not search-filtered)
  useEffect(() => {
    if (viewMode === 'flat') {
      const schemasToLoad = allSchemas.filter(s =>
        (showLibrary && s.source === 'library') ||
        (showCustom && s.source === 'uploaded')
      );
      schemasToLoad.forEach(s => {
        loadSchemaAcquisitions(s.id);
      });
    }
  }, [viewMode, allSchemas, showLibrary, showCustom]);

  // Check if an acquisition has a specific tag (acquisition-level tags only)
  const acquisitionHasTag = (acq: { tags?: string[] }, tag: string): boolean => {
    const acqTags = acq.tags || [];
    return acqTags.includes(tag);
  };

  // Helper to render tags with proper styling (analysis tags first, in purple)
  const renderAcquisitionTags = (tags: string[]) => {
    if (!tags || tags.length === 0) return null;

    // Sort: analysis tags first, then regular tags (both alphabetically)
    const sortedTags = [...tags].sort((a, b) => {
      const aIsAnalysis = isAnalysisTag(a);
      const bIsAnalysis = isAnalysisTag(b);
      if (aIsAnalysis && !bIsAnalysis) return -1;
      if (!aIsAnalysis && bIsAnalysis) return 1;
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    return (
      <div className="flex flex-wrap gap-1 mt-2">
        {sortedTags.map(tag => {
          const isAnalysis = isAnalysisTag(tag);
          const isSelected = selectedTags.includes(tag);
          const displayName = isAnalysis ? getAnalysisTagDisplayName(tag) : tag;

          return (
            <span
              key={tag}
              className={`px-1.5 py-0.5 text-xs rounded inline-flex items-center ${
                isAnalysis
                  ? isSelected
                    ? 'bg-purple-500/20 text-purple-700 dark:text-purple-300'
                    : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                  : isSelected
                    ? 'bg-brand-500/20 text-brand-700 dark:text-brand-300'
                    : 'bg-surface-tertiary text-content-tertiary'
              }`}
            >
              {isAnalysis && <FlaskConical className="h-2.5 w-2.5 mr-0.5" />}
              {displayName}
            </span>
          );
        })}
      </div>
    );
  };

  // Get indices of acquisitions that match the current tag filter (AND logic)
  const getMatchingAcquisitionIndices = (schema: UnifiedSchema, acquisitions: Acquisition[]): number[] => {
    if (selectedTags.length === 0) {
      // No filter - all acquisitions match
      return acquisitions.map((_, index) => index);
    }
    return acquisitions.map((_, index) => index).filter(index =>
      selectedTags.every(tag =>
        acquisitionHasTag({ tags: schema.acquisitions?.[index]?.tags }, tag)
      )
    );
  };

  // Flattened acquisitions list for flat view mode
  const flattenedAcquisitions = useMemo(() => {
    if (viewMode !== 'flat') return [];

    // Parse search keywords for acquisition-level filtering
    const keywords = searchQuery.trim()
      ? searchQuery.toLowerCase().split(/\s+/).filter(k => k.length > 0)
      : [];

    // In flat view, use all schemas filtered by source only (not by search)
    // We'll filter at the acquisition level instead
    let schemasForFlat = allSchemas.filter(s =>
      (showLibrary && s.source === 'library') ||
      (showCustom && s.source === 'uploaded')
    );

    const result = schemasForFlat.flatMap(schema => {
      const acquisitions = schemaAcquisitions[schema.id] || [];
      return acquisitions
        .map((acquisition, index) => {
          // Check tag match
          const matchesTag = selectedTags.length === 0 ||
            selectedTags.every(tag => acquisitionHasTag(
              { tags: schema.acquisitions?.[index]?.tags },
              tag
            ));
          // Check keyword match at the acquisition level
          const matchesKeywords = keywords.length === 0 ||
            acquisitionMatchesKeywords(schema, index, keywords);
          return { schema, acquisition, index, matchesTag, matchesKeywords };
        })
        .filter(item => item.matchesTag && item.matchesKeywords);
    });

    // Sort by score if acquisitionScores is provided
    // Primary: score descending, Secondary: passCount descending (more constraints = better match)
    if (acquisitionScores) {
      result.sort((a, b) => {
        const scoreObjA = acquisitionScores(a.schema.id, a.index);
        const scoreObjB = acquisitionScores(b.schema.id, b.index);
        const scoreA = scoreObjA?.score ?? -1;
        const scoreB = scoreObjB?.score ?? -1;
        if (scoreB !== scoreA) return scoreB - scoreA;
        // Tiebreak by passCount
        const passCountA = scoreObjA?.passCount ?? 0;
        const passCountB = scoreObjB?.passCount ?? 0;
        return passCountB - passCountA;
      });
    }

    return result;
  }, [viewMode, allSchemas, showLibrary, showCustom, schemaAcquisitions, selectedTags, searchQuery, acquisitionScores]);

  // Check if flat view is still loading acquisitions
  const isFlatViewLoading = viewMode === 'flat' && loadingSchemas.size > 0;

  // Multi-select helpers
  const isAcquisitionSelected = (schemaId: string, acquisitionIndex: number): boolean => {
    return selectedAcquisitions.some(
      sel => sel.schemaId === schemaId && sel.acquisitionIndex === acquisitionIndex
    );
  };

  // Get selection state - optionally filtered to only count specific indices
  const getSchemaSelectionState = (schemaId: string, totalAcquisitions: number, matchingIndices?: number[]): 'all' | 'some' | 'none' => {
    if (matchingIndices !== undefined) {
      // Only count selections within the matching indices
      const selectedMatchingCount = matchingIndices.filter(index => isAcquisitionSelected(schemaId, index)).length;
      if (selectedMatchingCount === 0) return 'none';
      if (selectedMatchingCount === matchingIndices.length) return 'all';
      return 'some';
    }
    // Original behavior - count all
    const selectedCount = selectedAcquisitions.filter(sel => sel.schemaId === schemaId).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === totalAcquisitions) return 'all';
    return 'some';
  };

  // Select/deselect acquisitions - optionally filtered to specific indices
  const handleSelectAllInSchema = (schema: UnifiedSchema, acquisitions: Acquisition[], matchingIndices?: number[]) => {
    if (!onAcquisitionToggle) return;

    const indicesToToggle = matchingIndices ?? acquisitions.map((_, i) => i);
    const selectionState = getSchemaSelectionState(schema.id, indicesToToggle.length, matchingIndices);

    if (selectionState === 'all') {
      // Deselect all matching - toggle each selected one
      indicesToToggle.forEach((index) => {
        if (isAcquisitionSelected(schema.id, index)) {
          onAcquisitionToggle({
            schemaId: schema.id,
            acquisitionIndex: index,
            schemaName: schema.name,
            acquisitionName: acquisitions[index].protocolName
          });
        }
      });
    } else {
      // Select all matching not yet selected
      indicesToToggle.forEach((index) => {
        if (!isAcquisitionSelected(schema.id, index)) {
          onAcquisitionToggle({
            schemaId: schema.id,
            acquisitionIndex: index,
            schemaName: schema.name,
            acquisitionName: acquisitions[index].protocolName
          });
        }
      });
    }
  };

  // Handler for Select All checkbox in schema header - loads acquisitions on demand
  const handleSelectAllClick = (schema: UnifiedSchema, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger expand/collapse

    const acquisitions = schemaAcquisitions[schema.id];

    if (!acquisitions) {
      // Trigger loading - checkbox will work once loaded
      loadSchemaAcquisitions(schema.id);
      return;
    }

    // If we have tag filters, only toggle matching acquisitions
    const matchingIndices = selectedTags.length > 0 ? getMatchingAcquisitionIndices(schema, acquisitions) : undefined;
    handleSelectAllInSchema(schema, acquisitions, matchingIndices);
  };

  const loadSchemaAcquisitions = async (schemaId: string) => {
    // Already cached in context
    if (fullAcquisitionsCache[schemaId]) {
      return;
    }

    // Already loading
    if (loadingSchemas.has(schemaId)) {
      return;
    }

    setLoadingSchemas(prev => new Set(prev).add(schemaId));

    try {
      // Use the context's loadFullAcquisitions which handles caching
      await loadFullAcquisitions(schemaId);
    } catch (error) {
      console.error(`Failed to load acquisitions for schema ${schemaId}:`, error);
    } finally {
      setLoadingSchemas(prev => {
        const newSet = new Set(prev);
        newSet.delete(schemaId);
        return newSet;
      });
    }
  };

  const toggleSchemaExpansion = async (schemaId: string) => {
    if (!expandable) return;

    setExpandedSchemas(prev => {
      const newSet = new Set(prev);
      if (newSet.has(schemaId)) {
        newSet.delete(schemaId);
      } else {
        newSet.add(schemaId);
        loadSchemaAcquisitions(schemaId);
      }
      return newSet;
    });
  };

  const handleSchemaClick = (schemaId: string) => {
    if (selectionMode === 'schema' && onSchemaSelect) {
      onSchemaSelect(schemaId);
    } else if (selectionMode === 'acquisition' && expandable) {
      toggleSchemaExpansion(schemaId);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith('.json')) {
        onSchemaUpload?.(file);
      }
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onSchemaUpload?.(e.target.files[0]);
    }
  };

  const handleDelete = (schemaId: string, schemaName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteModal({
      isOpen: true,
      schemaId,
      schemaName
    });
  };

  const confirmDelete = async () => {
    if (deleteModal.schemaId) {
      try {
        await deleteSchema(deleteModal.schemaId);
        console.log('Schema deleted successfully:', deleteModal.schemaId);
      } catch (error) {
        console.error('Failed to delete schema:', error);
      }
    }
    setDeleteModal({ isOpen: false, schemaId: '', schemaName: '' });
  };

  const handleDownload = async (schemaId: string, schemaName: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (onSchemaDownload) {
      onSchemaDownload(schemaId);
    } else {
      // Default download implementation
      try {
        const content = await getSchemaContent(schemaId);
        if (content) {
          const blob = new Blob([content], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${schemaName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_schema.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        console.error('Failed to download schema:', error);
      }
    }
  };

  // Render a schema card
  const renderSchemaCard = (schema: UnifiedSchema & { source: 'library' | 'uploaded' }) => {
    const isExpanded = expandedSchemas.has(schema.id);
    const acquisitions = schemaAcquisitions[schema.id] || [];
    const isLoading = loadingSchemas.has(schema.id);
    const isSelected = selectedSchemaId === schema.id;

    // For tag filtering, compute matching indices
    const loadedAcqs = schemaAcquisitions[schema.id];
    const matchingIndices = loadedAcqs && selectedTags.length > 0
      ? getMatchingAcquisitionIndices(schema, loadedAcqs)
      : undefined;
    const matchingCount = matchingIndices?.length ??
      (selectedTags.length > 0
        ? (schema.acquisitions?.filter((_, i) =>
            selectedTags.every(tag => acquisitionHasTag({ tags: schema.acquisitions?.[i]?.tags }, tag))
          ).length || 0)
        : (schema.acquisitions?.length || 1));
    const selectionState = getSchemaSelectionState(schema.id, matchingCount, matchingIndices);

    return (
      <div
        key={schema.id}
        className={`border rounded-lg bg-surface-primary shadow-sm transition-all ${
          isSelected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-border'
        }`}
      >
        {/* Schema Header - wrapped with DraggableSchema for dnd-kit support */}
        <DraggableSchema
          schemaId={schema.id}
          schemaName={schema.name}
          acquisitionCount={schema.acquisitions?.length || 1}
          enabled={enableDragDrop}
        >
          <div
            className={`px-4 py-3 rounded-t-lg cursor-pointer transition-colors ${
              selectionMode === 'schema'
                ? 'hover:bg-surface-secondary'
                : expandable
                  ? 'hover:bg-surface-secondary'
                  : ''
            } ${enableDragDrop ? 'cursor-grab active:cursor-grabbing' : ''}`}
            onClick={() => handleSchemaClick(schema.id)}
          >
          <div className="flex items-center justify-between">
            {/* Drag handle for schema */}
            {enableDragDrop && (
              <GripVertical className="h-4 w-4 text-content-muted mr-2 flex-shrink-0" />
            )}
            {/* Select All checkbox in header */}
            {multiSelectMode && (
              <div
                className="flex items-center justify-center mr-3 cursor-pointer"
                onClick={(e) => handleSelectAllClick(schema, e)}
                title={selectedTags.length > 0 ? `Select all ${matchingCount} matching acquisitions` : `Select all ${schema.acquisitions?.length || 1} acquisitions`}
              >
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                  loadingSchemas.has(schema.id)
                    ? 'border-border-secondary bg-surface-secondary'
                    : selectionState === 'all'
                      ? 'bg-brand-600 border-brand-600'
                      : selectionState === 'some'
                        ? 'bg-brand-600 border-brand-600'
                        : 'border-border-secondary bg-surface-primary hover:border-brand-400'
                }`}>
                  {loadingSchemas.has(schema.id) ? (
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-brand-600"></div>
                  ) : selectionState === 'all' ? (
                    <Check className="h-3 w-3 text-white" />
                  ) : selectionState === 'some' ? (
                    <Minus className="h-3 w-3 text-white" />
                  ) : null}
                </div>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center">
                <h3 className="text-sm font-semibold text-content-primary truncate">
                  {schema.name}
                </h3>
                {schema.source === 'library' && (
                  <Library className="h-3 w-3 text-content-tertiary ml-2 flex-shrink-0" />
                )}
                {schema.source === 'uploaded' && (
                  <FolderOpen className="h-3 w-3 text-content-tertiary ml-2 flex-shrink-0" />
                )}
              </div>
              <p className="text-xs text-content-secondary truncate mt-1">
                {schema.description || 'No description available'}
              </p>
              <div className="mt-2 flex items-center space-x-3 text-xs text-content-tertiary">
                <span>v{schema.version || '1.0.0'}</span>
                {schema.isMultiAcquisition && (
                  <>
                    <span>•</span>
                    <span className="px-2 py-0.5 bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 rounded-full">
                      {schema.acquisitions.length} acquisitions
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2 ml-4">
              {/* README button */}
              {onSchemaReadmeClick && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSchemaReadmeClick(schema.id, schema.name);
                  }}
                  className="p-1 text-content-tertiary hover:text-brand-600 transition-colors"
                  title="View README"
                >
                  <BookOpen className="h-4 w-4" />
                </button>
              )}

              {/* Open schema / Copy link */}
              {onOpenSchema ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenSchema(schema.id); }}
                  className="p-1 text-content-tertiary hover:text-brand-600 transition-colors"
                  title="Open schema"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={(e) => copySchemaLink(schema.id, e)}
                  className={`p-1 transition-colors ${copiedSchemaId === schema.id ? 'text-green-600 dark:text-green-400' : 'text-content-tertiary hover:text-brand-600'}`}
                  title={copiedSchemaId === schema.id ? 'Copied!' : 'Copy schema link'}
                >
                  {copiedSchemaId === schema.id ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                </button>
              )}

              {/* Download button */}
              <button
                onClick={(e) => handleDownload(schema.id, schema.name, e)}
                className="p-1 text-content-tertiary hover:text-brand-600 transition-colors"
                title="Save schema"
              >
                <Download className="h-4 w-4" />
              </button>

              {/* Delete button - only for custom schemas */}
              {schema.source === 'uploaded' && (
                <button
                  onClick={(e) => handleDelete(schema.id, schema.name, e)}
                  className="p-1 text-content-tertiary hover:text-status-error transition-colors"
                  title="Delete schema"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}

              {/* Expand chevron */}
              {expandable && selectionMode === 'acquisition' && (
                <div className="p-1 text-content-secondary">
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </div>
              )}
            </div>
          </div>
          </div>
        </DraggableSchema>

        {/* Expanded Acquisitions */}
        {expandable && isExpanded && selectionMode === 'acquisition' && (
          <div className="p-4 border-t border-border bg-surface-secondary">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600"></div>
                <span className="ml-2 text-sm text-content-secondary">Loading acquisitions...</span>
              </div>
            ) : acquisitions.length > 0 ? (
              (() => {
                // Parse search keywords for acquisition-level filtering
                const keywords = searchQuery.trim()
                  ? searchQuery.toLowerCase().split(/\s+/).filter(k => k.length > 0)
                  : [];

                // Split acquisitions into matching and non-matching (by both tags AND keywords)
                const allAcqs = acquisitions.map((acquisition, index) => ({
                  acquisition,
                  index,
                  matchesTag: selectedTags.length === 0 ||
                    selectedTags.every(tag =>
                      acquisitionHasTag(
                        { tags: schema.acquisitions?.[index]?.tags },
                        tag
                      )
                    ),
                  matchesKeywords: keywords.length === 0 ||
                    acquisitionMatchesKeywords(schema, index, keywords)
                }));
                const matchingAcqs = allAcqs.filter(a => a.matchesTag && a.matchesKeywords);
                const nonMatchingAcqs = allAcqs.filter(a => !a.matchesTag || !a.matchesKeywords);
                const showNonMatching = showNonMatchingFor.has(schema.id);

                const renderAcquisitionCard = ({ acquisition, index, matchesTag }: { acquisition: Acquisition; index: number; matchesTag: boolean }) => {
                  const isAcqSelected = multiSelectMode && isAcquisitionSelected(schema.id, index);
                  const acqSelection: AcquisitionSelection = {
                    schemaId: schema.id,
                    acquisitionIndex: index,
                    schemaName: schema.name,
                    acquisitionName: acquisition.protocolName
                  };

                  return multiSelectMode ? (
                    <DraggableAcquisition
                      key={acquisition.id}
                      selection={acqSelection}
                      acquisition={acquisition}
                      schemaName={schema.name}
                      tags={schema.acquisitions?.[index]?.tags}
                      enabled={enableDragDrop}
                    >
                      {(isDraggable) => (
                      <div
                        onClick={() => onAcquisitionToggle?.(acqSelection)}
                        className={`w-full text-left border rounded-lg p-3 bg-surface-primary cursor-pointer transition-all ${
                          isAcqSelected
                            ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                            : 'border-border-secondary hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:border-brand-300 dark:hover:border-brand-700'
                        }`}
                      >
                      <div className="flex items-start space-x-3">
                        {/* Drag handle visual indicator - entire card is draggable */}
                        {enableDragDrop && (
                          <div className="p-1 -m-1">
                            <GripVertical className="h-4 w-4 text-content-muted mt-0.5 flex-shrink-0" />
                          </div>
                        )}
                        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                          isAcqSelected
                            ? 'bg-brand-600 border-brand-600'
                            : 'border-border-secondary bg-surface-primary'
                        }`}>
                          {isAcqSelected && <Check className="h-3 w-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-content-primary">
                              {acquisition.protocolName}
                            </span>
                          </div>
                          {acquisition.seriesDescription && (
                            <div className="text-xs text-content-secondary mt-1">
                              {acquisition.seriesDescription}
                            </div>
                          )}
                          {/* Show acquisition tags */}
                          {renderAcquisitionTags(schema.acquisitions?.[index]?.tags || [])}
                          <div className="flex items-center space-x-4 mt-2 text-xs text-content-tertiary">
                            {(acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)) > 0 && (
                              <span className="flex items-center">
                                <List className="h-3 w-3 mr-1" />
                                {acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)} fields
                              </span>
                            )}
                            {acquisition.series && acquisition.series.length > 0 && (
                              <span>
                                {acquisition.series.length} series
                              </span>
                            )}
                            {acquisition.validationFunctions && acquisition.validationFunctions.length > 0 && (
                              <span className="text-brand-600 dark:text-brand-400">
                                {acquisition.validationFunctions.length} validation {acquisition.validationFunctions.length === 1 ? 'rule' : 'rules'}
                              </span>
                            )}
                          </div>
                        </div>
                        {acquisitionScores && (() => {
                          const scoreData = acquisitionScores(schema.id, index);
                          if (!scoreData) return null;
                          const { score } = scoreData;
                          const colorClass = score >= 80 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            score >= 60 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                            score >= 40 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                            'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
                          return (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 self-start mt-0.5 ${colorClass}`}>
                              {score}%
                            </span>
                          );
                        })()}
                        {/* README button for acquisition */}
                        {onAcquisitionReadmeClick && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onAcquisitionReadmeClick(schema.id, schema.name, index, acquisition.protocolName);
                            }}
                            className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start"
                            title="View README"
                          >
                            <BookOpen className="h-4 w-4" />
                          </button>
                        )}
                        {/* Open schema / Copy link */}
                        {onOpenSchema ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); onOpenSchema(schema.id); }}
                            className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start"
                            title="Open schema"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            onClick={(e) => copySchemaLink(schema.id, e)}
                            className={`p-1.5 transition-colors flex-shrink-0 self-start ${copiedSchemaId === schema.id ? 'text-green-600 dark:text-green-400' : 'text-content-tertiary hover:text-brand-600'}`}
                            title={copiedSchemaId === schema.id ? 'Copied!' : 'Copy schema link'}
                          >
                            {copiedSchemaId === schema.id ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                          </button>
                        )}
                      </div>
                      </div>
                      )}
                    </DraggableAcquisition>
                  ) : (
                    <button
                      key={acquisition.id}
                      onClick={() => onAcquisitionSelect?.(schema.id, index)}
                      className="w-full text-left border border-border-secondary rounded-lg p-3 bg-surface-primary transition-all hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:border-brand-300 dark:hover:border-brand-700"
                    >
                      <div className="flex items-start space-x-3">
                        <FileText className="h-5 w-5 text-content-tertiary mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-content-primary">
                              {acquisition.protocolName}
                            </span>
                          </div>
                          {acquisition.seriesDescription && (
                            <div className="text-xs text-content-secondary mt-1">
                              {acquisition.seriesDescription}
                            </div>
                          )}
                          {/* Show acquisition tags */}
                          {renderAcquisitionTags(schema.acquisitions?.[index]?.tags || [])}
                          <div className="flex items-center space-x-4 mt-2 text-xs text-content-tertiary">
                            {(acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)) > 0 && (
                              <span className="flex items-center">
                                <List className="h-3 w-3 mr-1" />
                                {acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)} fields
                              </span>
                            )}
                            {acquisition.series && acquisition.series.length > 0 && (
                              <span>
                                {acquisition.series.length} series
                              </span>
                            )}
                            {acquisition.validationFunctions && acquisition.validationFunctions.length > 0 && (
                              <span className="text-brand-600 dark:text-brand-400">
                                {acquisition.validationFunctions.length} validation {acquisition.validationFunctions.length === 1 ? 'rule' : 'rules'}
                              </span>
                            )}
                          </div>
                        </div>
                        {acquisitionScores && (() => {
                          const scoreData = acquisitionScores(schema.id, index);
                          if (!scoreData) return null;
                          const { score } = scoreData;
                          const colorClass = score >= 80 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            score >= 60 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                            score >= 40 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                            'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
                          return (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 self-start mt-0.5 ${colorClass}`}>
                              {score}%
                            </span>
                          );
                        })()}
                        {/* README button for acquisition */}
                        {onAcquisitionReadmeClick && (
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              onAcquisitionReadmeClick(schema.id, schema.name, index, acquisition.protocolName);
                            }}
                            className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start cursor-pointer"
                            title="View README"
                          >
                            <BookOpen className="h-4 w-4" />
                          </div>
                        )}
                        {/* Open schema / Copy link */}
                        {onOpenSchema ? (
                          <div
                            onClick={(e) => { e.stopPropagation(); onOpenSchema(schema.id); }}
                            className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start cursor-pointer"
                            title="Open schema"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </div>
                        ) : (
                          <div
                            onClick={(e) => copySchemaLink(schema.id, e)}
                            className={`p-1.5 transition-colors flex-shrink-0 self-start cursor-pointer ${copiedSchemaId === schema.id ? 'text-green-600 dark:text-green-400' : 'text-content-tertiary hover:text-brand-600'}`}
                            title={copiedSchemaId === schema.id ? 'Copied!' : 'Copy schema link'}
                          >
                            {copiedSchemaId === schema.id ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                };

                return (
                  <div className="space-y-2">
                    {/* Render matching acquisitions */}
                    {matchingAcqs.map(renderAcquisitionCard)}

                    {/* Show non-matching summary if there are any and filters are applied */}
                    {nonMatchingAcqs.length > 0 && (selectedTags.length > 0 || keywords.length > 0) && (
                      <>
                        <button
                          onClick={() => toggleShowNonMatching(schema.id)}
                          className="w-full flex items-center justify-center gap-2 py-2 px-3 border border-dashed border-border-secondary rounded-lg text-sm text-content-tertiary hover:text-content-secondary hover:border-content-muted transition-colors"
                        >
                          {showNonMatching ? (
                            <>
                              <ChevronUp className="h-4 w-4" />
                              Hide {nonMatchingAcqs.length} acquisition{nonMatchingAcqs.length !== 1 ? 's' : ''} not matching criteria
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-4 w-4" />
                              Show {nonMatchingAcqs.length} acquisition{nonMatchingAcqs.length !== 1 ? 's' : ''} not matching criteria
                            </>
                          )}
                        </button>

                        {/* Render non-matching acquisitions when expanded */}
                        {showNonMatching && (
                          <div className="space-y-2 opacity-60">
                            {nonMatchingAcqs.map(renderAcquisitionCard)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="text-center py-4 text-sm text-content-tertiary">
                No acquisitions found in this schema
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        className="bg-surface-primary rounded-lg shadow-md border border-border flex"
        style={{ height: maxHeight || 'calc(100vh - 300px)' }}
      >
        {/* Left Sidebar - Tags */}
        <div className="w-52 border-r border-border p-4 flex-shrink-0 flex flex-col">
          {/* Regular Tags Section */}
          <div className="flex-1 flex flex-col min-h-0 mb-4">
            <h3 className="font-medium text-sm text-content-primary mb-2 flex items-center flex-shrink-0">
              <Tag className="h-4 w-4 mr-2" />
              Tags
            </h3>
            {regularTagsWithCounts.length > 0 ? (
              <>
                <div className="relative mb-2 flex-shrink-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-content-tertiary" />
                  <input
                    type="text"
                    placeholder="Search tags..."
                    value={regularTagSearch}
                    onChange={(e) => setRegularTagSearch(e.target.value)}
                    className="w-full pl-7 pr-2 py-1 text-xs border border-border-secondary rounded bg-surface-primary text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>
                <div className="space-y-0.5 flex-1 overflow-y-auto min-h-0">
                  {filteredRegularTags.map(({ tag, count }) => (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className={`flex items-center justify-between w-full px-2 py-1 rounded text-xs transition-colors ${
                        selectedTags.includes(tag)
                          ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                          : 'hover:bg-surface-secondary text-content-secondary'
                      }`}
                    >
                      <span className="truncate">{tag}</span>
                      <span className={`text-xs ml-2 ${selectedTags.includes(tag) ? 'text-brand-600 dark:text-brand-400' : 'text-content-tertiary'}`}>
                        {count}
                      </span>
                    </button>
                  ))}
                  {filteredRegularTags.length === 0 && regularTagSearch && (
                    <p className="text-xs text-content-tertiary px-2 py-1">No matching tags</p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-content-tertiary">No tags available</p>
            )}
          </div>

          {/* Analysis Tags Section */}
          <div className="flex-1 flex flex-col min-h-0 border-t border-border pt-4">
            <h3 className="font-medium text-sm text-content-primary mb-2 flex items-center flex-shrink-0">
              <FlaskConical className="h-4 w-4 mr-2 text-purple-600 dark:text-purple-400" />
              Analysis
            </h3>
            {analysisTagsWithCounts.length > 0 ? (
              <>
                <div className="relative mb-2 flex-shrink-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-content-tertiary" />
                  <input
                    type="text"
                    placeholder="Search analysis..."
                    value={analysisTagSearch}
                    onChange={(e) => setAnalysisTagSearch(e.target.value)}
                    className="w-full pl-7 pr-2 py-1 text-xs border border-border-secondary rounded bg-surface-primary text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div className="space-y-0.5 flex-1 overflow-y-auto min-h-0">
                  {filteredAnalysisTags.map(({ tag, count }) => (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className={`flex items-center justify-between w-full px-2 py-1 rounded text-xs transition-colors ${
                        selectedTags.includes(tag)
                          ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                          : 'hover:bg-surface-secondary text-content-secondary'
                      }`}
                    >
                      <span className="truncate">{getAnalysisTagDisplayName(tag)}</span>
                      <span className={`text-xs ml-2 ${selectedTags.includes(tag) ? 'text-purple-600 dark:text-purple-400' : 'text-content-tertiary'}`}>
                        {count}
                      </span>
                    </button>
                  ))}
                  {filteredAnalysisTags.length === 0 && analysisTagSearch && (
                    <p className="text-xs text-content-tertiary px-2 py-1">No matching tags</p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-content-tertiary">No analysis tags available</p>
            )}
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header with search and source toggles */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-4">
              {/* Search */}
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-content-tertiary" />
                <input
                  type="text"
                  placeholder="Search schemas, acquisitions, tags..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-border-secondary rounded-lg bg-surface-primary text-sm text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>

              {/* Source toggles */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowLibrary(!showLibrary)}
                  className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors ${
                    showLibrary
                      ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                      : 'bg-surface-secondary text-content-tertiary hover:text-content-secondary'
                  }`}
                  title="Toggle library schemas"
                >
                  <Library className="h-4 w-4 mr-1.5" />
                  Library
                  {showLibrary && <Check className="h-3 w-3 ml-1.5" />}
                </button>
                <button
                  data-tutorial="uploaded-schemas"
                  onClick={() => setShowCustom(!showCustom)}
                  className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors ${
                    showCustom
                      ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                      : 'bg-surface-secondary text-content-tertiary hover:text-content-secondary'
                  }`}
                  title="Toggle custom schemas"
                >
                  <FolderOpen className="h-4 w-4 mr-1.5" />
                  Custom
                  {showCustom && <Check className="h-3 w-3 ml-1.5" />}
                </button>
              </div>

              {/* View mode toggle */}
              <div className="border-l border-border-secondary pl-4 ml-2">
                <label className="flex items-center gap-2 text-sm text-content-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={viewMode === 'nested'}
                    onChange={(e) => setViewMode(e.target.checked ? 'nested' : 'flat')}
                    className="w-4 h-4 rounded border-border-secondary text-brand-600 focus:ring-brand-500 focus:ring-offset-0"
                  />
                  Group schemas
                </label>
              </div>
            </div>

            {/* Active filters */}
            {selectedTags.length > 0 && (
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span className="text-sm text-content-secondary">Filters:</span>
                {selectedTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className="flex items-center px-2 py-1 bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 rounded text-xs hover:bg-brand-200 dark:hover:bg-brand-900/50 transition-colors"
                  >
                    {tag}
                    <X className="h-3 w-3 ml-1" />
                  </button>
                ))}
                <button
                  onClick={() => setSelectedTags([])}
                  className="text-xs text-content-tertiary hover:text-content-secondary transition-colors"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          {/* Schema list */}
          <div className="flex-1 overflow-y-auto p-4">
            {/* Upload Area - always show when onSchemaUpload is provided */}
            {onSchemaUpload && (
              <div className="mb-4" data-tutorial="schema-upload">
                <div
                  className={`relative border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
                    dragActive
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                      : 'border-border-secondary hover:border-content-muted'
                  }`}
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                >
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileInput}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <Upload className="h-6 w-6 text-content-muted mx-auto mb-2" />
                  <p className="text-sm text-content-secondary mb-1">
                    Drop schema file here or click to browse
                  </p>
                  <p className="text-xs text-content-tertiary">
                    Supports .json files
                  </p>
                </div>

                {/* Import from URL */}
                <div className="mt-2 flex items-center gap-2">
                  <div className="relative flex-1">
                    <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-content-muted" />
                    <input
                      type="url"
                      value={urlInput}
                      onChange={(e) => { setUrlInput(e.target.value); setUrlError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleUrlImport(); } }}
                      placeholder="…or paste a schema URL (e.g. GitHub raw / gist)"
                      className="w-full pl-8 pr-2 py-1.5 text-xs border border-border-secondary rounded-md bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleUrlImport}
                    disabled={!urlInput.trim() || urlImporting}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {urlImporting ? 'Importing…' : 'Import'}
                  </button>
                </div>
                {urlError && (
                  <p className="mt-1 text-xs text-status-error">{urlError}</p>
                )}
              </div>
            )}

            {viewMode === 'nested' ? (
              <>
                <div className="text-sm text-content-secondary mb-3">
                  {filteredSchemas.length} {filteredSchemas.length === 1 ? 'schema' : 'schemas'} found
                </div>
                {filteredSchemas.length > 0 ? (
                  <div className="space-y-4">
                    {filteredSchemas.map(schema => renderSchemaCard(schema))}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <p className="text-sm text-content-tertiary">
                      {searchQuery || selectedTags.length > 0
                        ? 'No schemas match your filters.'
                        : !showLibrary && !showCustom
                          ? 'Enable Library or Custom to see schemas.'
                          : 'No schemas available.'}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-sm text-content-secondary mb-3">
                  {isFlatViewLoading ? (
                    <span className="flex items-center">
                      <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-brand-600 mr-2"></span>
                      Loading acquisitions...
                    </span>
                  ) : (
                    <>{flattenedAcquisitions.length} {flattenedAcquisitions.length === 1 ? 'acquisition' : 'acquisitions'}{selectedTags.length > 0 ? ' matching' : ' found'}</>
                  )}
                </div>
                {isFlatViewLoading && flattenedAcquisitions.length === 0 ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600"></div>
                    <span className="ml-2 text-sm text-content-secondary">Loading acquisitions...</span>
                  </div>
                ) : flattenedAcquisitions.length > 0 ? (
                  <div className="space-y-2">
                    {flattenedAcquisitions.map(({ schema, acquisition, index }) => {
                      const isAcqSelected = multiSelectMode && isAcquisitionSelected(schema.id, index);
                      const flatAcqSelection: AcquisitionSelection = {
                        schemaId: schema.id,
                        acquisitionIndex: index,
                        schemaName: schema.name,
                        acquisitionName: acquisition.protocolName
                      };

                      return multiSelectMode ? (
                        <DraggableAcquisition
                          key={`${schema.id}-${index}`}
                          selection={flatAcqSelection}
                          acquisition={acquisition}
                          schemaName={schema.name}
                          tags={schema.acquisitions?.[index]?.tags}
                          enabled={enableDragDrop}
                        >
                          {(isDraggable) => (
                          <div
                            onClick={() => onAcquisitionToggle?.(flatAcqSelection)}
                            className={`w-full text-left border rounded-lg p-3 bg-surface-primary cursor-pointer transition-all ${
                              isAcqSelected
                                ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                                : 'border-border-secondary hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:border-brand-300 dark:hover:border-brand-700'
                            }`}
                          >
                          <div className="flex items-start space-x-3">
                            {/* Drag handle visual indicator - entire card is draggable */}
                            {enableDragDrop && (
                              <div className="p-1 -m-1">
                                <GripVertical className="h-4 w-4 text-content-muted mt-0.5 flex-shrink-0" />
                              </div>
                            )}
                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                              isAcqSelected
                                ? 'bg-brand-600 border-brand-600'
                                : 'border-border-secondary bg-surface-primary'
                            }`}>
                              {isAcqSelected && <Check className="h-3 w-3 text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm text-content-primary">
                                  {acquisition.protocolName}
                                </span>
                                <span className="text-xs text-content-tertiary bg-surface-tertiary px-2 py-0.5 rounded flex-shrink-0">
                                  {schema.name}
                                </span>
                              </div>
                              {acquisition.seriesDescription && (
                                <div className="text-xs text-content-secondary mt-1">
                                  {acquisition.seriesDescription}
                                </div>
                              )}
                              {renderAcquisitionTags(schema.acquisitions?.[index]?.tags || [])}
                              <div className="flex items-center space-x-4 mt-2 text-xs text-content-tertiary">
                                {(acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)) > 0 && (
                                  <span className="flex items-center">
                                    <List className="h-3 w-3 mr-1" />
                                    {acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)} fields
                                  </span>
                                )}
                                {acquisition.series && acquisition.series.length > 0 && (
                                  <span>{acquisition.series.length} series</span>
                                )}
                                {acquisition.validationFunctions && acquisition.validationFunctions.length > 0 && (
                                  <span className="text-brand-600 dark:text-brand-400">
                                    {acquisition.validationFunctions.length} validation {acquisition.validationFunctions.length === 1 ? 'rule' : 'rules'}
                                  </span>
                                )}
                              </div>
                            </div>
                            {acquisitionScores && (() => {
                              const scoreData = acquisitionScores(schema.id, index);
                              if (!scoreData) return null;
                              const { score } = scoreData;
                              const colorClass = score >= 80 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                score >= 60 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                                score >= 40 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
                              return (
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 self-start mt-0.5 ${colorClass}`}>
                                  {score}%
                                </span>
                              );
                            })()}
                            {onAcquisitionReadmeClick && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAcquisitionReadmeClick(schema.id, schema.name, index, acquisition.protocolName);
                                }}
                                className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start"
                                title="View README"
                              >
                                <BookOpen className="h-4 w-4" />
                              </button>
                            )}
                            {/* Open schema / Copy link */}
                            {onOpenSchema ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); onOpenSchema(schema.id); }}
                                className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start"
                                title="Open schema"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </button>
                            ) : (
                              <button
                                onClick={(e) => copySchemaLink(schema.id, e)}
                                className={`p-1.5 transition-colors flex-shrink-0 self-start ${copiedSchemaId === schema.id ? 'text-green-600 dark:text-green-400' : 'text-content-tertiary hover:text-brand-600'}`}
                                title={copiedSchemaId === schema.id ? 'Copied!' : 'Copy schema link'}
                              >
                                {copiedSchemaId === schema.id ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                              </button>
                            )}
                          </div>
                          </div>
                          )}
                        </DraggableAcquisition>
                      ) : (
                        <button
                          key={`${schema.id}-${index}`}
                          onClick={() => onAcquisitionSelect?.(schema.id, index)}
                          className="w-full text-left border border-border-secondary rounded-lg p-3 bg-surface-primary transition-all hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:border-brand-300 dark:hover:border-brand-700"
                        >
                          <div className="flex items-start space-x-3">
                            <FileText className="h-5 w-5 text-content-tertiary mt-0.5 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm text-content-primary">
                                  {acquisition.protocolName}
                                </span>
                                <span className="text-xs text-content-tertiary bg-surface-tertiary px-2 py-0.5 rounded flex-shrink-0">
                                  {schema.name}
                                </span>
                              </div>
                              {acquisition.seriesDescription && (
                                <div className="text-xs text-content-secondary mt-1">
                                  {acquisition.seriesDescription}
                                </div>
                              )}
                              {renderAcquisitionTags(schema.acquisitions?.[index]?.tags || [])}
                              <div className="flex items-center space-x-4 mt-2 text-xs text-content-tertiary">
                                {(acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)) > 0 && (
                                  <span className="flex items-center">
                                    <List className="h-3 w-3 mr-1" />
                                    {acquisition.acquisitionFields.length + (acquisition.series?.flatMap(s => s.fields).length || 0)} fields
                                  </span>
                                )}
                                {acquisition.series && acquisition.series.length > 0 && (
                                  <span>{acquisition.series.length} series</span>
                                )}
                                {acquisition.validationFunctions && acquisition.validationFunctions.length > 0 && (
                                  <span className="text-brand-600 dark:text-brand-400">
                                    {acquisition.validationFunctions.length} validation {acquisition.validationFunctions.length === 1 ? 'rule' : 'rules'}
                                  </span>
                                )}
                              </div>
                            </div>
                            {acquisitionScores && (() => {
                              const scoreData = acquisitionScores(schema.id, index);
                              if (!scoreData) return null;
                              const { score } = scoreData;
                              const colorClass = score >= 80 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                score >= 60 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                                score >= 40 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
                              return (
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 self-start mt-0.5 ${colorClass}`}>
                                  {score}%
                                </span>
                              );
                            })()}
                            {onAcquisitionReadmeClick && (
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAcquisitionReadmeClick(schema.id, schema.name, index, acquisition.protocolName);
                                }}
                                className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start cursor-pointer"
                                title="View README"
                              >
                                <BookOpen className="h-4 w-4" />
                              </div>
                            )}
                            {/* Open schema / Copy link */}
                            {onOpenSchema ? (
                              <div
                                onClick={(e) => { e.stopPropagation(); onOpenSchema(schema.id); }}
                                className="p-1.5 text-content-tertiary hover:text-brand-600 transition-colors flex-shrink-0 self-start cursor-pointer"
                                title="Open schema"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </div>
                            ) : (
                              <div
                                onClick={(e) => copySchemaLink(schema.id, e)}
                                className={`p-1.5 transition-colors flex-shrink-0 self-start cursor-pointer ${copiedSchemaId === schema.id ? 'text-green-600 dark:text-green-400' : 'text-content-tertiary hover:text-brand-600'}`}
                                title={copiedSchemaId === schema.id ? 'Copied!' : 'Copy schema link'}
                              >
                                {copiedSchemaId === schema.id ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <p className="text-sm text-content-tertiary">
                      {searchQuery || selectedTags.length > 0
                        ? 'No acquisitions match your filters.'
                        : !showLibrary && !showCustom
                          ? 'Enable Library or Custom to see acquisitions.'
                          : 'No acquisitions available.'}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={deleteModal.isOpen}
        schemaName={deleteModal.schemaName}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteModal({ isOpen: false, schemaId: '', schemaName: '' })}
      />
    </>
  );
};

export default UnifiedSchemaSelector;
