/**
 * Utilities for fetching and validating external schema JSON files.
 */

/**
 * Fetches schema JSON from an external URL with CORS error handling.
 * Returns the raw JSON string on success.
 */
export async function fetchExternalSchema(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
  } catch {
    throw new Error(
      `Failed to fetch schema from "${url}". This may be due to CORS restrictions ` +
      `on the remote server. Try downloading the schema file and uploading it directly in the workspace.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch schema: HTTP ${response.status} ${response.statusText}`
    );
  }

  const text = await response.text();

  try {
    JSON.parse(text);
  } catch {
    throw new Error('The fetched content is not valid JSON.');
  }

  return text;
}

/**
 * Validates that a parsed schema object has the required dicompare structure.
 * Throws a descriptive error if the schema is invalid.
 */
export function validateSchemaStructure(schema: any): void {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Schema must be a JSON object.');
  }
  if (!schema.acquisitions || typeof schema.acquisitions !== 'object') {
    throw new Error(
      'Invalid schema: missing or invalid "acquisitions" property. ' +
      'A valid dicompare schema must have an "acquisitions" object.'
    );
  }
  if (Object.keys(schema.acquisitions).length === 0) {
    throw new Error('Schema has no acquisitions defined.');
  }
}
