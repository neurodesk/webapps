import { useState, useCallback } from 'react';
import { ReadmeItem } from '../components/schema/SchemaReadmeModal';
import { buildReadmeItems } from '../utils/readmeHelpers';
import { fetchAndParseSchema } from '../utils/schemaHelpers';

export interface ReadmeModalData {
  schemaName: string;
  readmeItems: ReadmeItem[];
  initialSelection: string;
}

export interface UseReadmeModalReturn {
  showReadmeModal: boolean;
  readmeModalData: ReadmeModalData | null;
  handleSchemaReadmeClick: (schemaId: string, schemaName: string) => Promise<void>;
  handleAcquisitionReadmeClick: (schemaId: string, schemaName: string, acquisitionIndex: number) => Promise<void>;
  closeReadmeModal: () => void;
}

/**
 * Hook for managing README modal state and handlers.
 * Consolidates duplicated README modal logic from UnifiedWorkspace and WorkspaceDetailPanel.
 *
 * @param getSchemaContent - Function to fetch schema content by ID
 * @returns README modal state and handlers
 */
export function useReadmeModal(
  getSchemaContent: (id: string) => Promise<string | null>
): UseReadmeModalReturn {
  const [showReadmeModal, setShowReadmeModal] = useState(false);
  const [readmeModalData, setReadmeModalData] = useState<ReadmeModalData | null>(null);

  const handleSchemaReadmeClick = useCallback(async (schemaId: string, schemaName: string) => {
    const schemaData = await fetchAndParseSchema(schemaId, getSchemaContent);
    if (schemaData) {
      setReadmeModalData({
        schemaName,
        readmeItems: buildReadmeItems(schemaData, schemaName),
        initialSelection: 'schema'
      });
      setShowReadmeModal(true);
    }
  }, [getSchemaContent]);

  const handleAcquisitionReadmeClick = useCallback(async (
    schemaId: string,
    schemaName: string,
    acquisitionIndex: number
  ) => {
    const schemaData = await fetchAndParseSchema(schemaId, getSchemaContent);
    if (schemaData) {
      setReadmeModalData({
        schemaName,
        readmeItems: buildReadmeItems(schemaData, schemaName),
        initialSelection: `acquisition-${acquisitionIndex}`
      });
      setShowReadmeModal(true);
    }
  }, [getSchemaContent]);

  const closeReadmeModal = useCallback(() => {
    setShowReadmeModal(false);
    setReadmeModalData(null);
  }, []);

  return {
    showReadmeModal,
    readmeModalData,
    handleSchemaReadmeClick,
    handleAcquisitionReadmeClick,
    closeReadmeModal
  };
}
