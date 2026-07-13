import { WorkspaceItem, SchemaMetadata } from '../contexts/workspace/types';
import { SchemaBinding, UnifiedSchema } from '../hooks/useSchemaService';
import { dicomFileCache } from './dicomFileCache';
import {
  SerializedWorkspaceItem,
  SerializedSchemaBinding,
  StoredFileBatch,
  StoredFileData,
} from '../services/SessionStorageManager';

// --- Serialization (runtime -> storage) ---

export function serializeWorkspaceItems(items: WorkspaceItem[]): SerializedWorkspaceItem[] {
  return items.map(item => ({
    ...item,
    isEditing: false,
    attachedSchema: item.attachedSchema
      ? serializeSchemaBinding(item.attachedSchema)
      : undefined,
  }));
}

function serializeSchemaBinding(binding: SchemaBinding): SerializedSchemaBinding {
  return {
    schemaId: binding.schemaId,
    acquisitionId: binding.acquisitionId,
    acquisitionName: binding.acquisitionName,
  };
}

export function collectFileBatchIds(items: WorkspaceItem[]): string[] {
  const batchIds = new Set<string>();
  for (const item of items) {
    if (item.dicomFileBatchId) batchIds.add(item.dicomFileBatchId);
    if (item.attachedDataBatchId) batchIds.add(item.attachedDataBatchId);
  }
  return Array.from(batchIds);
}

export async function serializeFileBatch(
  sessionId: string,
  batchId: string
): Promise<StoredFileBatch | null> {
  const files = dicomFileCache.get(batchId);
  if (!files || files.length === 0) return null;

  const storedFiles: StoredFileData[] = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      webkitRelativePath: (file as any).webkitRelativePath || '',
      type: file.type,
      lastModified: file.lastModified,
      buffer: await file.arrayBuffer(),
    }))
  );

  return {
    id: `${sessionId}_${batchId}`,
    sessionId,
    batchId,
    files: storedFiles,
  };
}

// --- Deserialization (storage -> runtime) ---

export function deserializeWorkspaceItems(
  serialized: SerializedWorkspaceItem[],
  getUnifiedSchema: (id: string) => UnifiedSchema | null
): WorkspaceItem[] {
  return serialized.map(item => ({
    ...item,
    attachedSchema: item.attachedSchema
      ? reconstructSchemaBinding(item.attachedSchema, getUnifiedSchema)
      : undefined,
  }));
}

function reconstructSchemaBinding(
  ref: SerializedSchemaBinding,
  getUnifiedSchema: (id: string) => UnifiedSchema | null
): SchemaBinding | undefined {
  const schema = getUnifiedSchema(ref.schemaId);
  if (!schema) {
    console.warn(`Session restore: schema ${ref.schemaId} not found, dropping binding`);
    return undefined;
  }
  return {
    schemaId: ref.schemaId,
    acquisitionId: ref.acquisitionId,
    acquisitionName: ref.acquisitionName,
    schema,
  };
}

export function restoreFileBatches(batches: StoredFileBatch[]): void {
  for (const batch of batches) {
    const files = batch.files.map((f) => {
      const file = new File([f.buffer], f.name, {
        type: f.type,
        lastModified: f.lastModified,
      });
      if (f.webkitRelativePath) {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: f.webkitRelativePath,
          writable: false,
        });
      }
      return file;
    });
    dicomFileCache.set(batch.batchId, files);
  }
}

export function generateSessionName(schemaMetadata: SchemaMetadata): string {
  if (schemaMetadata.name && schemaMetadata.name.trim()) {
    return schemaMetadata.name.trim();
  }
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `Session ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
