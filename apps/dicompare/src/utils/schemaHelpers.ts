/**
 * Utility functions for schema fetching and parsing.
 */

/**
 * Fetch and parse a schema by ID.
 * Consolidates the repeated pattern of getSchemaContent + JSON.parse.
 *
 * @param schemaId - The schema ID to fetch
 * @param getSchemaContent - Function to fetch schema content by ID
 * @returns The parsed schema data, or null if not found or on error
 */
export async function fetchAndParseSchema(
  schemaId: string,
  getSchemaContent: (id: string) => Promise<string | null>
): Promise<any | null> {
  try {
    const content = await getSchemaContent(schemaId);
    if (!content) return null;
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to fetch and parse schema:', error);
    return null;
  }
}
