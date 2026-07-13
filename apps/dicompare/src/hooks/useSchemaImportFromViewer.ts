import { useEffect, useRef } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { AcquisitionSelection } from '../types';
import { UnifiedSchema } from './useSchemaService';

interface PendingSchemaImport {
  schemaId: string | null;
  schemaUrl: string | null;
  schemaContent: string | null;
  selectedAcquisitionIndices: number[];
  schemaName: string;
  acquisitionNames: string[];
}

/**
 * Hook that checks sessionStorage for a pending schema import from the Schema Viewer page
 * and loads the selected acquisitions into the workspace.
 *
 * Provides custom getSchemaContent/getUnifiedSchema implementations that use the
 * embedded schema content, so we don't depend on the library being loaded.
 */
export function useSchemaImportFromViewer() {
  const {
    addFromSchema,
    selectItem,
  } = useWorkspace();
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (hasProcessed.current) return;

    const raw = sessionStorage.getItem('pendingSchemaImport');
    if (!raw) return;

    hasProcessed.current = true;
    sessionStorage.removeItem('pendingSchemaImport');

    const processImport = async () => {
      try {
        const pending: PendingSchemaImport = JSON.parse(raw);

        if (pending.selectedAcquisitionIndices.length === 0 || !pending.schemaContent) return;

        const schemaId = pending.schemaId || `external_${Date.now()}`;
        const parsed = JSON.parse(pending.schemaContent);

        // Build a UnifiedSchema from the embedded content
        const unifiedSchema: UnifiedSchema = {
          id: schemaId,
          name: parsed.name || pending.schemaName,
          description: parsed.description || '',
          category: pending.schemaId ? 'Library' : 'External',
          content: pending.schemaContent,
          format: 'json',
          version: parsed.version,
          authors: parsed.authors,
          acquisitions: [],
          isMultiAcquisition: Object.keys(parsed.acquisitions || {}).length > 1,
        };

        // Custom getters that return data we already have, bypassing the library
        const getSchemaContent = async () => pending.schemaContent;
        const getUnifiedSchema = () => unifiedSchema;

        const selections: AcquisitionSelection[] = pending.selectedAcquisitionIndices.map(idx => ({
          schemaId,
          acquisitionIndex: idx,
          schemaName: pending.schemaName,
          acquisitionName: pending.acquisitionNames[idx] || `Acquisition ${idx}`,
        }));

        const newItemIds = await addFromSchema(selections, getSchemaContent, getUnifiedSchema);
        if (newItemIds.length > 0) {
          selectItem(newItemIds[newItemIds.length - 1]);
        }
      } catch (err) {
        console.error('Failed to process pending schema import:', err);
      }
    };

    processImport();
  }, [addFromSchema, selectItem]);
}
