/**
 * Acquisition matching utilities for auto-matching uploaded test data
 * to existing workspace references based on compliance scores.
 */

import { Acquisition } from '../types';
import { ComplianceFieldResult } from '../types/schema';
import { WorkspaceItem } from '../contexts/workspace/types';
import { dicompareWorkerAPI as dicompareAPI } from '../services/DicompareWorkerAPI';

export interface MatchScore {
  uploadedIndex: number;
  itemId: string;
  score: number; // 0-100
  complianceResults: ComplianceFieldResult[];
  passCount: number;
  failCount: number;
  warningCount: number;
  totalCount: number;
}

export interface SuggestedMatch {
  uploadedIndex: number;
  itemId: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Get the reference acquisition from a workspace item.
 * Handles different item sources (schema, data-as-schema, attached schema).
 */
function getReferenceAcquisition(item: WorkspaceItem): Acquisition | null {
  // Item has an attached schema binding - need to get the acquisition from the schema
  if (item.attachedSchema) {
    // The schema binding has the schema content but we need to extract the acquisition
    // For now, we can't easily get this without more context, so skip these
    // The item's own acquisition is validation-subject, not the reference
    return null;
  }

  // Schema-sourced item: the acquisition IS the reference
  if (item.source === 'schema') {
    return item.acquisition;
  }

  // Data-sourced item being used as schema-template: use the acquisition as reference
  if (item.source === 'data' && item.dataUsageMode === 'schema-template') {
    return item.acquisition;
  }

  // Empty item with created schema
  if (item.source === 'empty' && item.hasCreatedSchema) {
    return item.acquisition;
  }

  return null;
}

/**
 * Compute compliance scores between all uploaded acquisitions and available slots.
 * Returns a matrix of scores for all combinations.
 */
export async function computeMatchScores(
  uploadedAcquisitions: Acquisition[],
  availableSlots: Array<{ itemId: string; item: WorkspaceItem }>
): Promise<MatchScore[]> {
  const scores: MatchScore[] = [];

  for (let i = 0; i < uploadedAcquisitions.length; i++) {
    const uploaded = uploadedAcquisitions[i];

    for (const slot of availableSlots) {
      const refAcquisition = getReferenceAcquisition(slot.item);

      if (!refAcquisition) {
        // Can't get reference acquisition, skip this slot
        continue;
      }

      try {
        // Run validation to get compliance results
        const results = await dicompareAPI.validateAcquisitionAgainstAcquisition(
          uploaded,
          refAcquisition
        ) as ComplianceFieldResult[];

        // Calculate score based on pass/fail counts
        const passCount = results.filter(r => r.status === 'pass').length;
        const failCount = results.filter(r => r.status === 'fail').length;
        const warningCount = results.filter(r => r.status === 'warning').length;
        // Only count results that have a definitive status
        const totalCount = results.filter(
          r => r.status !== 'na' && r.status !== 'unknown'
        ).length;

        const score = totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 0;

        scores.push({
          uploadedIndex: i,
          itemId: slot.itemId,
          score,
          complianceResults: results,
          passCount,
          failCount,
          warningCount,
          totalCount
        });
      } catch (error) {
        console.error(
          `Failed to compute match score for upload ${i} vs item ${slot.itemId}:`,
          error
        );
        // Add a zero score on error so the pairing is still available
        scores.push({
          uploadedIndex: i,
          itemId: slot.itemId,
          score: 0,
          complianceResults: [],
          passCount: 0,
          failCount: 0,
          warningCount: 0,
          totalCount: 0
        });
      }
    }
  }

  return scores;
}

/**
 * Suggest optimal matches using a greedy algorithm.
 * Matches highest scores first, ensuring each item/acquisition is used only once.
 *
 * @param scores - Array of match scores from computeMatchScores
 * @param minConfidenceScore - Minimum score to consider (default 30)
 * @returns Array of suggested matches sorted by confidence
 */
export function suggestMatches(
  scores: MatchScore[],
  minConfidenceScore: number = 30
): SuggestedMatch[] {
  // Sort by score descending, then by passCount for ties (more constraints = better match)
  const sortedScores = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.passCount - a.passCount;
  });

  const usedUploaded = new Set<number>();
  const usedItems = new Set<string>();
  const suggestions: SuggestedMatch[] = [];

  for (const score of sortedScores) {
    // Skip if already matched
    if (usedUploaded.has(score.uploadedIndex) || usedItems.has(score.itemId)) {
      continue;
    }

    // Only suggest if above minimum threshold
    if (score.score >= minConfidenceScore) {
      usedUploaded.add(score.uploadedIndex);
      usedItems.add(score.itemId);

      const confidence: 'high' | 'medium' | 'low' =
        score.score >= 80 ? 'high' : score.score >= 50 ? 'medium' : 'low';

      suggestions.push({
        uploadedIndex: score.uploadedIndex,
        itemId: score.itemId,
        score: score.score,
        confidence
      });
    }
  }

  return suggestions;
}

/**
 * Get the best score for a specific upload/item pair from the scores array.
 */
export function getScoreForPair(
  scores: MatchScore[],
  uploadedIndex: number,
  itemId: string
): MatchScore | undefined {
  return scores.find(
    s => s.uploadedIndex === uploadedIndex && s.itemId === itemId
  );
}
