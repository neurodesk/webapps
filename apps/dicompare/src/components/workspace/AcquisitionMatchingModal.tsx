import React, { useState, useEffect, useMemo } from 'react';
import { X, Loader2, Zap, FlaskConical, FileText } from 'lucide-react';
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
import { Acquisition } from '../../types';
import { WorkspaceItem } from '../../contexts/workspace/types';
import {
  MatchScore,
  SuggestedMatch,
  computeMatchScores,
  suggestMatches,
  getScoreForPair
} from '../../utils/acquisitionMatching';

// Helper to get color classes based on compliance score
function getScoreColors(score: number | undefined): {
  border: string;
  bg: string;
  text: string;
  icon: string;
  badge: string;
} {
  if (score === undefined) {
    return {
      border: 'border-gray-300 dark:border-gray-600',
      bg: 'bg-gray-50 dark:bg-gray-900/10',
      text: 'text-gray-600 dark:text-gray-400',
      icon: 'text-gray-500',
      badge: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
    };
  }
  if (score >= 80) {
    return {
      border: 'border-green-400 dark:border-green-600',
      bg: 'bg-green-50 dark:bg-green-900/10',
      text: 'text-green-700 dark:text-green-400',
      icon: 'text-green-600',
      badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    };
  }
  if (score >= 60) {
    return {
      border: 'border-yellow-400 dark:border-yellow-600',
      bg: 'bg-yellow-50 dark:bg-yellow-900/10',
      text: 'text-yellow-700 dark:text-yellow-400',
      icon: 'text-yellow-600',
      badge: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    };
  }
  if (score >= 40) {
    return {
      border: 'border-orange-400 dark:border-orange-600',
      bg: 'bg-orange-50 dark:bg-orange-900/10',
      text: 'text-orange-700 dark:text-orange-400',
      icon: 'text-orange-600',
      badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    };
  }
  return {
    border: 'border-red-400 dark:border-red-600',
    bg: 'bg-red-50 dark:bg-red-900/10',
    text: 'text-red-700 dark:text-red-400',
    icon: 'text-red-600',
    badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  };
}

interface AcquisitionMatchingModalProps {
  isOpen: boolean;
  uploadedAcquisitions: Acquisition[];
  availableSlots: Array<{ itemId: string; item: WorkspaceItem }>;
  initialAssignments?: Array<{ uploadedIndex: number; itemId: string }>;
  onConfirm: (matches: Array<{ uploadedIndex: number; itemId: string | null }>) => void;
  onCancel: () => void;
}

// Compact draggable card for uploaded acquisition
const DraggableAcquisition: React.FC<{
  acquisition: Acquisition;
  index: number;
  score?: number;
  compact?: boolean;
}> = ({ acquisition, index, score, compact }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `upload-${index}`,
    data: { type: 'upload', index, acquisition }
  });

  const colors = getScoreColors(compact ? score : undefined);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`
        rounded-lg border cursor-grab active:cursor-grabbing
        ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}
        ${isDragging
          ? 'opacity-50 border-brand-500 bg-brand-50 dark:bg-brand-900/20'
          : compact
            ? `${colors.border} bg-surface-primary hover:border-brand-400`
            : 'border-border bg-surface-primary hover:border-brand-400'
        }
      `}
    >
      <div className="flex items-center gap-2">
        <FlaskConical className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} text-amber-500 flex-shrink-0`} />
        <span className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-content-primary truncate flex-1`}>
          {acquisition.protocolName || `Acquisition ${index + 1}`}
        </span>
        {score !== undefined && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${colors.badge}`}>
            {score}%
          </span>
        )}
      </div>
    </div>
  );
};

// Overlay shown while dragging
const DragOverlayContent: React.FC<{ acquisition: Acquisition; index: number }> = ({ acquisition, index }) => (
  <div className="px-3 py-2 rounded-lg border border-brand-500 bg-brand-50 dark:bg-brand-900/30 shadow-lg">
    <div className="flex items-center gap-2">
      <FlaskConical className="h-4 w-4 text-amber-500 flex-shrink-0" />
      <span className="text-sm font-medium text-content-primary truncate">
        {acquisition.protocolName || `Acquisition ${index + 1}`}
      </span>
    </div>
  </div>
);

// Compact horizontal zone for unmatched items
const UnmatchedZone: React.FC<{
  uploadedAcquisitions: Acquisition[];
  matches: Map<number, string>;
  getSuggestedScore: (idx: number) => number | undefined;
}> = ({ uploadedAcquisitions, matches, getSuggestedScore }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: 'unmatched-zone',
    data: { type: 'unmatched' }
  });

  const unmatchedCount = uploadedAcquisitions.length - matches.size;
  const hasUnmatched = unmatchedCount > 0;

  return (
    <div
      ref={setNodeRef}
      className={`
        rounded-lg border-2 border-dashed p-2 transition-colors
        ${isOver
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
          : hasUnmatched
            ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-700'
            : 'border-border bg-surface-secondary'
        }
      `}
    >
      <div className="text-xs font-medium text-content-secondary mb-2 flex items-center gap-1">
        <FlaskConical className="h-3 w-3" />
        Unmatched Test Data ({unmatchedCount})
      </div>
      <div className="flex flex-wrap gap-2">
        {uploadedAcquisitions.map((acq, idx) => {
          if (matches.has(idx)) return null;
          return (
            <DraggableAcquisition
              key={idx}
              acquisition={acq}
              index={idx}
              score={getSuggestedScore(idx)}
            />
          );
        })}
        {unmatchedCount === 0 && (
          <div className="text-xs text-content-tertiary py-1">
            All matched! Drag here to unmatch.
          </div>
        )}
      </div>
    </div>
  );
};

// Droppable reference slot
const ReferenceSlot: React.FC<{
  slot: { itemId: string; item: WorkspaceItem };
  matchedAcquisition?: { acquisition: Acquisition; index: number; score?: MatchScore };
  bestScore?: number;
}> = ({ slot, matchedAcquisition, bestScore }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot-${slot.itemId}`,
    data: { type: 'slot', itemId: slot.itemId }
  });

  const matchScore = matchedAcquisition?.score?.score;
  const colors = getScoreColors(matchScore);

  return (
    <div
      ref={setNodeRef}
      className={`
        rounded-lg border-2 border-dashed p-2 transition-colors
        ${isOver
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
          : matchedAcquisition
            ? `${colors.border} ${colors.bg}`
            : 'border-border bg-surface-secondary'
        }
      `}
    >
      {/* Reference header */}
      <div className="flex items-center gap-2 mb-2">
        <FileText className={`h-4 w-4 flex-shrink-0 ${matchedAcquisition ? colors.icon : 'text-content-tertiary'}`} />
        <span className="text-sm font-medium text-content-primary truncate flex-1">
          {slot.item.acquisition.protocolName || 'Untitled'}
        </span>
        {!matchedAcquisition && bestScore !== undefined && (
          <span className={`text-xs ${getScoreColors(bestScore).text}`}>
            best: {bestScore}%
          </span>
        )}
      </div>

      {/* Matched content (draggable) or drop hint */}
      {matchedAcquisition ? (
        <DraggableAcquisition
          acquisition={matchedAcquisition.acquisition}
          index={matchedAcquisition.index}
          score={matchedAcquisition.score?.score}
          compact
        />
      ) : (
        <div className="text-xs text-content-tertiary text-center py-2">
          Drop test data here
        </div>
      )}
    </div>
  );
};

const AcquisitionMatchingModal: React.FC<AcquisitionMatchingModalProps> = ({
  isOpen,
  uploadedAcquisitions,
  availableSlots,
  initialAssignments,
  onConfirm,
  onCancel
}) => {
  const [matches, setMatches] = useState<Map<number, string>>(new Map());
  const [matchScores, setMatchScores] = useState<MatchScore[]>([]);
  const [isComputing, setIsComputing] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedMatch[]>([]);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Initialize from initialAssignments when modal opens
  useEffect(() => {
    if (isOpen && !hasInitialized) {
      // Start with initial assignments if provided
      if (initialAssignments && initialAssignments.length > 0) {
        const initialMap = new Map<number, string>();
        initialAssignments.forEach(a => initialMap.set(a.uploadedIndex, a.itemId));
        setMatches(initialMap);
      } else {
        setMatches(new Map());
      }
      setHasInitialized(true);

      // Compute scores in background
      if (uploadedAcquisitions.length > 0 && availableSlots.length > 0) {
        computeScores();
      }
    }
  }, [isOpen, hasInitialized, initialAssignments, uploadedAcquisitions.length, availableSlots.length]);

  // Reset when modal closes
  useEffect(() => {
    if (!isOpen) {
      setHasInitialized(false);
    }
  }, [isOpen]);

  const computeScores = async () => {
    setIsComputing(true);
    setComputeError(null);
    try {
      const scores = await computeMatchScores(uploadedAcquisitions, availableSlots);
      setMatchScores(scores);

      const suggested = suggestMatches(scores);
      setSuggestions(suggested);
      // Don't auto-apply suggestions - preserve the initial/current state
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
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;

    const activeData = active.data.current;
    const uploadIndex = activeData?.index as number;

    // If dropped on the unmatched zone or nowhere, unmatch it
    if (!over || over.id === 'unmatched-zone') {
      const newMatches = new Map(matches);
      newMatches.delete(uploadIndex);
      setMatches(newMatches);
      return;
    }

    const overData = over.data.current;

    if (activeData?.type === 'upload' && overData?.type === 'slot') {
      const slotId = overData.itemId as string;

      // Remove any existing match to this slot (if another item was there)
      const newMatches = new Map(matches);
      for (const [idx, itemId] of newMatches.entries()) {
        if (itemId === slotId && idx !== uploadIndex) {
          newMatches.delete(idx);
        }
      }
      // Set new match
      newMatches.set(uploadIndex, slotId);
      setMatches(newMatches);
    }
  };

  const handleConfirm = () => {
    const matchArray = uploadedAcquisitions.map((_, idx) => ({
      uploadedIndex: idx,
      itemId: matches.get(idx) || null
    }));
    onConfirm(matchArray);
  };

  // Get best score for each slot (for hint display)
  const getBestScoreForSlot = (slotId: string): number | undefined => {
    const slotScores = matchScores.filter(s => s.itemId === slotId);
    if (slotScores.length === 0) return undefined;
    return Math.max(...slotScores.map(s => s.score));
  };

  // Get suggested score for unmatched uploads
  const getSuggestedScore = (uploadIndex: number): number | undefined => {
    const suggestion = suggestions.find(s => s.uploadedIndex === uploadIndex);
    return suggestion?.score;
  };

  // Stats
  const stats = useMemo(() => {
    const matched = matches.size;
    const unmatched = uploadedAcquisitions.length - matched;
    return { matched, unmatched };
  }, [matches, uploadedAcquisitions.length]);

  // Active drag item
  const activeDragData = useMemo(() => {
    if (!activeId) return null;
    const match = activeId.match(/^upload-(\d+)$/);
    if (!match) return null;
    const index = parseInt(match[1]);
    return { acquisition: uploadedAcquisitions[index], index };
  }, [activeId, uploadedAcquisitions]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-content-primary">
              Match Test Data to References
            </h2>
            <p className="text-xs text-content-secondary mt-0.5">
              Drag test data onto references to match them
            </p>
          </div>
          <button onClick={onCancel} className="text-content-muted hover:text-content-secondary">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Loading state */}
        {isComputing && (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center">
              <Loader2 className="h-6 w-6 animate-spin text-brand-600 mx-auto mb-2" />
              <p className="text-sm text-content-secondary">Computing matches...</p>
            </div>
          </div>
        )}

        {/* Main content */}
        {!isComputing && (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Actions bar */}
              <div className="px-5 py-2 border-b border-border bg-surface-secondary flex items-center justify-between">
                <div className="text-xs text-content-secondary">
                  {computeError ? (
                    <span className="text-status-warning">{computeError}</span>
                  ) : (
                    <span>{stats.matched} matched, {stats.unmatched} unmatched</span>
                  )}
                </div>
                <button
                  onClick={handleApplyAllSuggestions}
                  disabled={suggestions.length === 0}
                  className="px-2 py-1 text-xs bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  <Zap className="h-3 w-3" />
                  Auto-match
                </button>
              </div>

              {/* Main content area */}
              <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
                {/* Unmatched items - compact horizontal area at top */}
                <UnmatchedZone
                  uploadedAcquisitions={uploadedAcquisitions}
                  matches={matches}
                  getSuggestedScore={getSuggestedScore}
                />

                {/* References grid - main area */}
                <div className="flex-1">
                  <div className="text-xs font-medium text-content-secondary mb-2 flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    References ({availableSlots.length})
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {availableSlots.map(slot => {
                      // Find if any upload is matched to this slot
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
                          matchedAcquisition={matchedData}
                          bestScore={!matchedData ? getBestScoreForSlot(slot.itemId) : undefined}
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

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-content-secondary border border-border-secondary rounded hover:bg-surface-secondary"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 text-sm text-white bg-brand-600 rounded hover:bg-brand-700"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

export default AcquisitionMatchingModal;
