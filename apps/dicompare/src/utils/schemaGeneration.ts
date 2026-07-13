/**
 * Schema generation utilities.
 * Consolidates the repeated pattern from generatePreview, handleDownloadJson, and generateJsonForSave.
 */

import { dicompareWorkerAPI as dicompareAPI } from '../services/DicompareWorkerAPI';
import { SchemaMetadata } from '../contexts/WorkspaceContext';
import { Acquisition } from '../types';

export interface SchemaGenerationOptions {
  acquisitions: Acquisition[];
  metadata: SchemaMetadata;
  description?: string;
}

export interface GeneratedSchema {
  json: string;
  schema: Record<string, unknown>;
}

/**
 * Generate schema JSON from acquisitions and metadata.
 *
 * @param options - Schema generation options
 * @returns Generated schema object and JSON string
 */
export async function generateSchemaJson(
  options: SchemaGenerationOptions
): Promise<GeneratedSchema> {
  const { acquisitions, metadata, description } = options;

  const schema = await dicompareAPI.generateSchemaJS(acquisitions, {
    name: metadata.name || 'Untitled Schema',
    description: description ?? metadata.description ?? '',
    version: metadata.version || '1.0',
    authors: metadata.authors || [],
  });

  // Remove statistics from exported schema
  const { statistics, ...schemaContent } = schema;

  return {
    json: JSON.stringify(schemaContent, null, 2),
    schema: schemaContent,
  };
}

/**
 * Download a schema as a JSON file.
 *
 * @param json - The JSON string to download
 * @param name - Schema name (used for filename)
 * @param version - Schema version (used for filename)
 */
export function downloadSchemaJson(
  json: string,
  name: string,
  version: string
): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/\s+/g, '_')}_v${version}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Copy text to clipboard.
 *
 * @param text - Text to copy
 * @returns Promise that resolves when copied
 */
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
