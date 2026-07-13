/**
 * Utility functions for handling schema tags, including analysis tags.
 *
 * Analysis tags use the prefix "analysis:" (e.g., "analysis:qsm", "analysis:diffusion")
 * to indicate compatibility with specific analysis pipelines.
 */

export const ANALYSIS_TAG_PREFIX = 'analysis:';

/**
 * Check if a tag is an analysis tag (starts with "analysis:")
 */
export function isAnalysisTag(tag: string): boolean {
  return tag.toLowerCase().startsWith(ANALYSIS_TAG_PREFIX);
}

/**
 * Get the display name of an analysis tag (without the prefix)
 * Preserves the original case of the tag name.
 * e.g., "analysis:qsm" → "qsm", "analysis:QSM" → "QSM"
 */
export function getAnalysisTagDisplayName(tag: string): string {
  if (!isAnalysisTag(tag)) return tag;
  return tag.slice(ANALYSIS_TAG_PREFIX.length);
}

/**
 * Split an array of tags into analysis tags and regular tags.
 * Both arrays are sorted alphabetically.
 */
export function splitTags(tags: string[]): { analysisTags: string[]; regularTags: string[] } {
  const analysisTags = tags
    .filter(isAnalysisTag)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const regularTags = tags
    .filter(t => !isAnalysisTag(t))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { analysisTags, regularTags };
}

/**
 * Split tags with counts into analysis and regular categories.
 * Both arrays are sorted alphabetically by tag name.
 */
export function splitTagsWithCounts(
  tagsWithCounts: Array<{ tag: string; count: number }>
): {
  analysisTagsWithCounts: Array<{ tag: string; count: number }>;
  regularTagsWithCounts: Array<{ tag: string; count: number }>;
} {
  const analysisTagsWithCounts = tagsWithCounts
    .filter(({ tag }) => isAnalysisTag(tag))
    .sort((a, b) => a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
  const regularTagsWithCounts = tagsWithCounts
    .filter(({ tag }) => !isAnalysisTag(tag))
    .sort((a, b) => a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
  return { analysisTagsWithCounts, regularTagsWithCounts };
}
