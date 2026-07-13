import { ReadmeItem } from '../components/schema/SchemaReadmeModal';

/**
 * Build README items from schema data for the sidebar navigation.
 * Used by both UnifiedWorkspace and WorkspaceDetailPanel.
 */
export function buildReadmeItems(schemaData: any, schemaName: string): ReadmeItem[] {
  const items: ReadmeItem[] = [];

  // Schema-level README
  items.push({
    id: 'schema',
    type: 'schema',
    name: schemaName,
    description: schemaData.description || ''
  });

  // Acquisition READMEs
  Object.entries(schemaData.acquisitions || {}).forEach(([name, acqData]: [string, any], index) => {
    items.push({
      id: `acquisition-${index}`,
      type: 'acquisition',
      name: name,
      description: acqData?.detailed_description || acqData?.description || '',
      acquisitionIndex: index
    });
  });

  return items;
}
