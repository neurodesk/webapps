import React, { useState, useMemo, useCallback } from 'react';
import { X, Loader2, Zap, ArrowUpDown } from 'lucide-react';
import UnifiedSchemaSelector from '../schema/UnifiedSchemaSelector';
import { UnifiedSchema, SchemaBinding } from '../../hooks/useSchemaService';
import { Acquisition } from '../../types';
import { dicompareWorkerAPI } from '../../services/DicompareWorkerAPI';
import { ComplianceFieldResult } from '../../types/schema';

interface AcquisitionScore {
  schemaId: string;
  acquisitionIndex: number;
  score: number;
  passCount: number;
  failCount: number;
  totalCount: number;
}

interface AttachSchemaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (binding: SchemaBinding) => void;
  librarySchemas: UnifiedSchema[];
  uploadedSchemas: UnifiedSchema[];
  getSchemaContent: (schemaId: string) => Promise<string | null>;
  testDataAcquisition?: Acquisition;
  onSchemaReadmeClick?: (schemaId: string, schemaName: string) => void;
  onAcquisitionReadmeClick?: (schemaId: string, schemaName: string, acquisitionIndex: number) => void;
}

const AttachSchemaModal: React.FC<AttachSchemaModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  librarySchemas,
  uploadedSchemas,
  getSchemaContent,
  testDataAcquisition,
  onSchemaReadmeClick,
  onAcquisitionReadmeClick
}) => {
  const [isComputing, setIsComputing] = useState(false);
  const [scores, setScores] = useState<AcquisitionScore[]>([]);
  const [sortByScore, setSortByScore] = useState(false);

  // Build sorted schemas based on scores
  const sortedSchemas = useMemo(() => {
    if (!sortByScore || scores.length === 0) {
      return { librarySchemas, uploadedSchemas };
    }

    // Create a map of best scores per schema (score and passCount for tiebreaking)
    const schemaScores = new Map<string, { score: number; passCount: number }>();
    scores.forEach(s => {
      const current = schemaScores.get(s.schemaId);
      // Update if no current score, or if new score is better, or if tied score but more passes
      if (!current ||
          s.score > current.score ||
          (s.score === current.score && s.passCount > current.passCount)) {
        schemaScores.set(s.schemaId, { score: s.score, passCount: s.passCount });
      }
    });

    const sortSchemas = (schemas: UnifiedSchema[]) => {
      return [...schemas].sort((a, b) => {
        const scoreA = schemaScores.get(a.id) ?? { score: -1, passCount: 0 };
        const scoreB = schemaScores.get(b.id) ?? { score: -1, passCount: 0 };
        // Primary: score descending, Secondary: passCount descending
        if (scoreB.score !== scoreA.score) return scoreB.score - scoreA.score;
        return scoreB.passCount - scoreA.passCount;
      });
    };

    return {
      librarySchemas: sortSchemas(librarySchemas),
      uploadedSchemas: sortSchemas(uploadedSchemas)
    };
  }, [librarySchemas, uploadedSchemas, scores, sortByScore]);

  // Get score for a specific acquisition
  const getAcquisitionScore = useCallback((schemaId: string, acquisitionIndex: number): AcquisitionScore | undefined => {
    return scores.find(s => s.schemaId === schemaId && s.acquisitionIndex === acquisitionIndex);
  }, [scores]);

  const computeScores = async () => {
    if (!testDataAcquisition) return;

    setIsComputing(true);
    const newScores: AcquisitionScore[] = [];
    const allSchemas = [...librarySchemas, ...uploadedSchemas];

    for (const schema of allSchemas) {
      for (let i = 0; i < schema.acquisitions.length; i++) {
        const refAcquisition = schema.acquisitions[i];
        try {
          // Use validateAcquisitionAgainstSchema which fetches full schema content
          // (SchemaAcquisition only has metadata, not the actual field definitions)
          const results = await dicompareWorkerAPI.validateAcquisitionAgainstSchema(
            testDataAcquisition,
            schema.id,
            getSchemaContent,
            i.toString()
          ) as ComplianceFieldResult[];

          const passCount = results.filter(r => r.status === 'pass').length;
          const failCount = results.filter(r => r.status === 'fail').length;
          const totalCount = results.filter(r => r.status !== 'na' && r.status !== 'unknown').length;
          const score = totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 0;

          newScores.push({
            schemaId: schema.id,
            acquisitionIndex: i,
            score,
            passCount,
            failCount,
            totalCount
          });
        } catch (error) {
          console.error(`Failed to compute score for ${schema.name} / ${refAcquisition.protocolName}:`, error);
          newScores.push({
            schemaId: schema.id,
            acquisitionIndex: i,
            score: 0,
            passCount: 0,
            failCount: 0,
            totalCount: 0
          });
        }
      }
    }

    setScores(newScores);
    setSortByScore(true);
    setIsComputing(false);
  };

  const handleAcquisitionSelect = (schemaId: string, acquisitionIndex: number) => {
    const allSchemas = [...librarySchemas, ...uploadedSchemas];
    const schema = allSchemas.find(s => s.id === schemaId);

    if (schema) {
      const acquisition = schema.acquisitions[acquisitionIndex];
      const binding: SchemaBinding = {
        schemaId,
        acquisitionId: acquisitionIndex.toString(),
        acquisitionName: acquisition?.protocolName,
        schema
      };
      onSelect(binding);
    }
  };

  // Reset state when modal closes
  if (!isOpen) {
    if (scores.length > 0) {
      setScores([]);
      setSortByScore(false);
    }
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" data-tutorial="attach-schema-modal">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-content-primary">Attach Schema</h2>
            <p className="text-sm text-content-secondary mt-1">
              Select a schema acquisition to validate against
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-content-muted hover:text-content-secondary"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Actions bar */}
        {testDataAcquisition && (
          <div className="px-6 py-2 border-b border-border bg-surface-secondary flex items-center justify-between">
            <div className="text-sm text-content-secondary">
              {scores.length > 0 ? (
                <span className="flex items-center gap-2">
                  <span className="text-green-600">✓</span>
                  Computed {scores.length} match scores
                </span>
              ) : (
                <span>Compute match scores to find the best reference</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {scores.length > 0 && (
                <button
                  data-tutorial="scores-computed"
                  onClick={() => setSortByScore(!sortByScore)}
                  className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${
                    sortByScore
                      ? 'bg-brand-600 text-white'
                      : 'border border-border text-content-secondary hover:bg-surface-tertiary'
                  }`}
                >
                  <ArrowUpDown className="h-3 w-3" />
                  Sort by match
                </button>
              )}
              <button
                data-tutorial="find-best-matches-button"
                onClick={computeScores}
                disabled={isComputing}
                className="px-3 py-1 text-xs bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {isComputing ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Computing...
                  </>
                ) : (
                  <>
                    <Zap className="h-3 w-3" />
                    {scores.length > 0 ? 'Recompute' : 'Find best matches'}
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 p-6 min-h-0">
          <UnifiedSchemaSelector
            librarySchemas={sortedSchemas.librarySchemas}
            uploadedSchemas={sortedSchemas.uploadedSchemas}
            selectionMode="acquisition"
            multiSelectMode={false}
            onAcquisitionSelect={handleAcquisitionSelect}
            expandable={true}
            getSchemaContent={getSchemaContent}
            onSchemaReadmeClick={onSchemaReadmeClick}
            onAcquisitionReadmeClick={onAcquisitionReadmeClick}
            acquisitionScores={scores.length > 0 ? getAcquisitionScore : undefined}
            maxHeight="calc(80vh - 180px)"
          />
        </div>
      </div>
    </div>
  );
};

export default AttachSchemaModal;
