import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Zap, FlaskConical, FileText, GripVertical, ArrowRight, Check, X, Waypoints } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  DragStartEvent,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Acquisition } from '../../../types';
import { WorkspaceItem } from '../../../contexts/workspace/types';
import {
  MatchScore,
  SuggestedMatch,
  computeMatchScores,
  suggestMatches,
  getScoreForPair
} from '../../../utils/acquisitionMatching';

// Summary of derived diffusion gradient descriptors on an acquisition, if any.
function gradientSummary(acq: Acquisition): { shells: number; volumes?: number } | null {
  const get = (name: string) => acq.acquisitionFields?.find(f => (f.keyword || f.name) === name)?.value;
  const shells = get('NumberOfDiffusionShells');
  if (shells === undefined) return null;
  return { shells: shells as number, volumes: get('NumberOfDiffusionVolumes') as number | undefined };
}

// Small chip indicating diffusion gradient descriptors are attached.
const GradientChip: React.FC<{ acquisition: Acquisition }> = ({ acquisition }) => {
  const summary = gradientSummary(acquisition);
  if (!summary) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
      title={`Diffusion gradient attached · ${summary.shells} shell${summary.shells === 1 ? '' : 's'}${summary.volumes !== undefined ? ` · ${summary.volumes} volumes` : ''}`}
    >
      <Waypoints className="h-3 w-3" />
      {summary.shells} shell{summary.shells === 1 ? '' : 's'}
    </span>
  );
};

// Helper to get color classes based on compliance score
function getScoreConfig(score: number | undefined): {
  ring: string;
  bg: string;
  text: string;
  badge: string;
  indicator: string;
} {
  if (score === undefined) {
    return {
      ring: 'ring-gray-200 dark:ring-gray-700',
      bg: 'bg-gray-50 dark:bg-gray-800/50',
      text: 'text-gray-500 dark:text-gray-400',
      badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
      indicator: 'bg-gray-300 dark:bg-gray-600'
    };
  }
  if (score >= 80) {
    return {
      ring: 'ring-emerald-300 dark:ring-emerald-600',
      bg: 'bg-emerald-50 dark:bg-emerald-900/20',
      text: 'text-emerald-600 dark:text-emerald-400',
      badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      indicator: 'bg-emerald-500'
    };
  }
  if (score >= 60) {
    return {
      ring: 'ring-amber-300 dark:ring-amber-600',
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      text: 'text-amber-600 dark:text-amber-400',
      badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      indicator: 'bg-amber-500'
    };
  }
  if (score >= 40) {
    return {
      ring: 'ring-orange-300 dark:ring-orange-600',
      bg: 'bg-orange-50 dark:bg-orange-900/20',
      text: 'text-orange-600 dark:text-orange-400',
      badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
      indicator: 'bg-orange-500'
    };
  }
  return {
    ring: 'ring-red-300 dark:ring-red-600',
    bg: 'bg-red-50 dark:bg-red-900/20',
    text: 'text-red-600 dark:text-red-400',
    badge: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    indicator: 'bg-red-500'
  };
}

interface MatchingPanelProps {
  uploadedAcquisitions: Acquisition[];
  availableSlots: Array<{ itemId: string; item: WorkspaceItem }>;
  initialAssignments?: Array<{ uploadedIndex: number; itemId: string }>;
  onConfirm: (matches: Array<{ uploadedIndex: number; itemId: string | null }>) => void;
}

// Draggable test data card
const DraggableDataCard: React.FC<{
  acquisition: Acquisition;
  index: number;
  score?: number;
  isMatched?: boolean;
  onRemove?: () => void;
}> = ({ acquisition, index, score, isMatched, onRemove }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `upload-${index}`,
    data: { type: 'upload', index, acquisition }
  });

  const colors = getScoreConfig(score);

  return (
    <div
      ref={setNodeRef}
      className={`
        group relative rounded-xl transition-all duration-200
        ${isDragging
          ? 'opacity-40 scale-95'
          : 'hover:shadow-md'
        }
        ${isMatched
          ? `ring-2 ${colors.ring} ${colors.bg}`
          : 'bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-brand-300 dark:hover:ring-brand-600'
        }
      `}
    >
      <div
        {...listeners}
        {...attributes}
        className="flex items-center gap-3 p-3 cursor-grab active:cursor-grabbing"
      >
        <div className="flex-shrink-0 text-gray-400 dark:text-gray-500">
          <GripVertical className="h-4 w-4" />
        </div>
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
          <FlaskConical className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {acquisition.protocolName || `Test Data ${index + 1}`}
          </div>
          {acquisition.seriesDescription && (
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {acquisition.seriesDescription}
            </div>
          )}
          {gradientSummary(acquisition) && (
            <div className="mt-1"><GradientChip acquisition={acquisition} /></div>
          )}
        </div>
        {score !== undefined && (
          <div className={`flex-shrink-0 px-2 py-1 rounded-full text-xs font-semibold ${colors.badge}`}>
            {score}%
          </div>
        )}
      </div>
      {isMatched && onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-700 ring-2 ring-white dark:ring-gray-800 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-100 dark:hover:bg-red-900/30"
        >
          <X className="h-3 w-3 text-gray-500 hover:text-red-500" />
        </button>
      )}
    </div>
  );
};

// Overlay shown while dragging
const DragOverlayContent: React.FC<{ acquisition: Acquisition; index: number }> = ({ acquisition, index }) => (
  <div className="rounded-xl bg-white dark:bg-gray-800 ring-2 ring-brand-500 shadow-xl p-3 flex items-center gap-3">
    <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
      <FlaskConical className="h-4 w-4 text-amber-600 dark:text-amber-400" />
    </div>
    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
      {acquisition.protocolName || `Test Data ${index + 1}`}
    </span>
  </div>
);

// Unmatched zone (left column drop target)
const UnmatchedZone: React.FC<{
  uploadedAcquisitions: Acquisition[];
  matches: Map<number, string>;
  matchScores: MatchScore[];
  suggestions: SuggestedMatch[];
}> = ({ uploadedAcquisitions, matches, matchScores, suggestions }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: 'unmatched-zone',
    data: { type: 'unmatched' }
  });

  const unmatchedIndices = uploadedAcquisitions
    .map((_, idx) => idx)
    .filter(idx => !matches.has(idx));

  const getSuggestedScore = (idx: number) => {
    const suggestion = suggestions.find(s => s.uploadedIndex === idx);
    return suggestion?.score;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
          <FlaskConical className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Test Data
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {uploadedAcquisitions.length} total
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={`
          flex-1 rounded-xl border-2 border-dashed p-3 transition-all duration-200 overflow-auto
          ${isOver
            ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/20'
            : unmatchedIndices.length > 0
              ? 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50'
          }
        `}
      >
        {uploadedAcquisitions.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4">
            <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
              <FlaskConical className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">No test data yet</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Add test data in the <span className="font-medium text-brand-600 dark:text-brand-400">From data</span> area, then it'll appear here to match.
            </p>
          </div>
        ) : unmatchedIndices.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4">
            <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-3">
              <Check className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">All matched!</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Drag items here to unmatch
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {unmatchedIndices.map(idx => (
              <DraggableDataCard
                key={idx}
                acquisition={uploadedAcquisitions[idx]}
                index={idx}
                score={getSuggestedScore(idx)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Reference slot drop target
const ReferenceSlot: React.FC<{
  slot: { itemId: string; item: WorkspaceItem };
  matchedData?: { acquisition: Acquisition; index: number; score?: MatchScore };
  bestScore?: number;
  onRemoveMatch?: () => void;
}> = ({ slot, matchedData, bestScore, onRemoveMatch }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${slot.itemId}`,
    data: { type: 'slot', itemId: slot.itemId }
  });

  const matchScore = matchedData?.score?.score;
  const colors = getScoreConfig(matchScore);

  return (
    <div
      ref={setNodeRef}
      className={`
        rounded-xl transition-all duration-200 overflow-hidden
        ${isOver
          ? 'ring-2 ring-brand-500 bg-brand-50 dark:bg-brand-900/20'
          : matchedData
            ? `ring-2 ${colors.ring} ${colors.bg}`
            : 'ring-1 ring-gray-200 dark:ring-gray-700 bg-white dark:bg-gray-800'
        }
      `}
    >
      {/* Reference header */}
      <div className={`
        px-3 py-2 border-b flex items-center gap-2
        ${matchedData
          ? 'border-transparent bg-white/50 dark:bg-gray-800/50'
          : 'border-gray-100 dark:border-gray-700'
        }
      `}>
        <div className={`
          w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0
          ${matchedData
            ? 'bg-white dark:bg-gray-800'
            : 'bg-blue-100 dark:bg-blue-900/30'
          }
        `}>
          <FileText className={`h-4 w-4 ${matchedData ? colors.text : 'text-blue-600 dark:text-blue-400'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {slot.item.acquisition.protocolName || 'Reference'}
          </div>
          {gradientSummary(slot.item.acquisition) && (
            <div className="mt-0.5"><GradientChip acquisition={slot.item.acquisition} /></div>
          )}
        </div>
        {matchedData && matchScore !== undefined && (
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${colors.indicator}`} />
            <span className={`text-xs font-semibold ${colors.text}`}>
              {matchScore}%
            </span>
          </div>
        )}
        {!matchedData && bestScore !== undefined && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            Best: {bestScore}%
          </span>
        )}
      </div>

      {/* Drop zone / matched content */}
      <div className="p-2 min-h-[72px]">
        {matchedData ? (
          <DraggableDataCard
            acquisition={matchedData.acquisition}
            index={matchedData.index}
            score={matchScore}
            isMatched
            onRemove={onRemoveMatch}
          />
        ) : (
          <div className={`
            h-full min-h-[56px] rounded-lg border-2 border-dashed flex items-center justify-center transition-colors
            ${isOver
              ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/20'
              : 'border-gray-200 dark:border-gray-700'
            }
          `}>
            <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500">
              <ArrowRight className="h-4 w-4" />
              <span className="text-xs">Drop test data here</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const MatchingPanel: React.FC<MatchingPanelProps> = ({
  uploadedAcquisitions,
  availableSlots,
  initialAssignments,
  onConfirm
}) => {
  const [matches, setMatches] = useState<Map<number, string>>(new Map());
  const [matchScores, setMatchScores] = useState<MatchScore[]>([]);
  const [isComputing, setIsComputing] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedMatch[]>([]);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [userHasInteracted, setUserHasInteracted] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Store onConfirm in a ref to avoid dependency issues
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  // Initialize from initialAssignments when panel mounts
  useEffect(() => {
    if (!hasInitialized) {
      if (initialAssignments && initialAssignments.length > 0) {
        const initialMap = new Map<number, string>();
        initialAssignments.forEach(a => initialMap.set(a.uploadedIndex, a.itemId));
        setMatches(initialMap);
      } else {
        setMatches(new Map());
      }
      setHasInitialized(true);

      if (uploadedAcquisitions.length > 0 && availableSlots.length > 0) {
        computeScores();
      }
    }
  }, [hasInitialized, initialAssignments, uploadedAcquisitions.length, availableSlots.length]);

  const computeScores = async () => {
    setIsComputing(true);
    setComputeError(null);
    try {
      const scores = await computeMatchScores(uploadedAcquisitions, availableSlots);
      setMatchScores(scores);
      const suggested = suggestMatches(scores);
      setSuggestions(suggested);
    } catch (error) {
      console.error('Failed to compute match scores:', error);
      setComputeError('Failed to compute match quality.');
    } finally {
      setIsComputing(false);
    }
  };

  const handleApplyAllSuggestions = () => {
    const newMatches = new Map<number, string>();
    suggestions.forEach(s => newMatches.set(s.uploadedIndex, s.itemId));
    setMatches(newMatches);
    setUserHasInteracted(true);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;

    const activeData = active.data.current;
    const uploadIndex = activeData?.index as number;

    if (!over || over.id === 'unmatched-zone') {
      const newMatches = new Map(matches);
      newMatches.delete(uploadIndex);
      setMatches(newMatches);
      setUserHasInteracted(true);
      return;
    }

    const overData = over.data.current;

    if (activeData?.type === 'upload' && overData?.type === 'slot') {
      const slotId = overData.itemId as string;
      const newMatches = new Map(matches);
      for (const [idx, itemId] of newMatches.entries()) {
        if (itemId === slotId && idx !== uploadIndex) {
          newMatches.delete(idx);
        }
      }
      newMatches.set(uploadIndex, slotId);
      setMatches(newMatches);
      setUserHasInteracted(true);
    }
  };

  const handleRemoveMatch = (uploadIndex: number) => {
    const newMatches = new Map(matches);
    newMatches.delete(uploadIndex);
    setMatches(newMatches);
    setUserHasInteracted(true);
  };

  // Store uploadedAcquisitions length in ref to avoid dependency issues
  const uploadedCountRef = useRef(uploadedAcquisitions.length);
  useEffect(() => {
    uploadedCountRef.current = uploadedAcquisitions.length;
  }, [uploadedAcquisitions.length]);

  // Apply matches immediately whenever user makes changes
  useEffect(() => {
    if (!hasInitialized || !userHasInteracted) return;

    const matchArray = Array.from({ length: uploadedCountRef.current }, (_, idx) => ({
      uploadedIndex: idx,
      itemId: matches.get(idx) || null
    }));
    onConfirmRef.current(matchArray);

    // Reset interaction flag after applying to prevent re-triggering
    setUserHasInteracted(false);
  }, [matches, hasInitialized, userHasInteracted]);

  const getBestScoreForSlot = (slotId: string): number | undefined => {
    const slotScores = matchScores.filter(s => s.itemId === slotId);
    if (slotScores.length === 0) return undefined;
    return Math.max(...slotScores.map(s => s.score));
  };

  // Stats
  const stats = useMemo(() => {
    const matched = matches.size;
    const unmatched = uploadedAcquisitions.length - matched;
    const avgScore = matched > 0
      ? Math.round(
          Array.from(matches.entries()).reduce((sum, [idx, itemId]) => {
            const score = getScoreForPair(matchScores, idx, itemId);
            return sum + (score?.score || 0);
          }, 0) / matched
        )
      : 0;
    return { matched, unmatched, avgScore };
  }, [matches, uploadedAcquisitions.length, matchScores]);

  // Active drag item
  const activeDragData = useMemo(() => {
    if (!activeId) return null;
    const match = activeId.match(/^upload-(\d+)$/);
    if (!match) return null;
    const index = parseInt(match[1]);
    return { acquisition: uploadedAcquisitions[index], index };
  }, [activeId, uploadedAcquisitions]);

  return (
    <div data-tutorial="matching-panel" className="bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Match Test Data to References
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Drag and drop test data onto reference slots to create matches
            </p>
          </div>
          <button
            data-tutorial="auto-match-button"
            onClick={handleApplyAllSuggestions}
            disabled={suggestions.length === 0 || isComputing}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed"
          >
            <Zap className="h-4 w-4" />
            Auto-match All
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-6 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-sm text-gray-600 dark:text-gray-300">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{stats.matched}</span> matched
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-sm text-gray-600 dark:text-gray-300">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{stats.unmatched}</span> unmatched
            </span>
          </div>
          {stats.matched > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-sm text-gray-600 dark:text-gray-300">
                <span className="font-semibold text-gray-900 dark:text-gray-100">{stats.avgScore}%</span> avg match
              </span>
            </div>
          )}
          {computeError && (
            <span className="text-sm text-red-500">{computeError}</span>
          )}
        </div>
      </div>

      {/* Loading state */}
      {isComputing && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center mx-auto mb-3">
              <Loader2 className="h-6 w-6 animate-spin text-brand-600 dark:text-brand-400" />
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Computing match scores...</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Analyzing {uploadedAcquisitions.length} × {availableSlots.length} combinations
            </p>
          </div>
        </div>
      )}

      {/* Main content - side by side layout */}
      {!isComputing && (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex-1 overflow-hidden flex p-4 gap-4">
            {/* Left column - Unmatched test data */}
            <div className="w-80 flex-shrink-0">
              <UnmatchedZone
                uploadedAcquisitions={uploadedAcquisitions}
                matches={matches}
                matchScores={matchScores}
                suggestions={suggestions}
              />
            </div>

            {/* Right column - References */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <FileText className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                </div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  References
                </h3>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {availableSlots.length} slots
                </span>
              </div>

              <div className="flex-1 overflow-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {availableSlots.map(slot => {
                    let matchedData: { acquisition: Acquisition; index: number; score?: MatchScore } | undefined;
                    for (const [idx, itemId] of matches.entries()) {
                      if (itemId === slot.itemId) {
                        const score = getScoreForPair(matchScores, idx, itemId);
                        matchedData = {
                          acquisition: uploadedAcquisitions[idx],
                          index: idx,
                          score
                        };
                        break;
                      }
                    }

                    return (
                      <ReferenceSlot
                        key={slot.itemId}
                        slot={slot}
                        matchedData={matchedData}
                        bestScore={!matchedData ? getBestScoreForSlot(slot.itemId) : undefined}
                        onRemoveMatch={matchedData ? () => handleRemoveMatch(matchedData!.index) : undefined}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Drag overlay */}
          <DragOverlay>
            {activeDragData && (
              <DragOverlayContent
                acquisition={activeDragData.acquisition}
                index={activeDragData.index}
              />
            )}
          </DragOverlay>
        </DndContext>
      )}

    </div>
  );
};

export default MatchingPanel;
