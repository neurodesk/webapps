import { Acquisition } from '../types';
import { SchemaMetadata } from '../contexts/workspace/types';

// --- Serialized types (stored in IndexedDB) ---

export interface SerializedSchemaBinding {
  schemaId: string;
  acquisitionId?: string;
  acquisitionName?: string;
}

export interface SerializedWorkspaceItem {
  id: string;
  acquisition: Acquisition;
  source: 'schema' | 'data' | 'empty';
  isEditing: boolean;
  dataUsageMode?: 'schema-template' | 'validation-subject';
  attachedData?: Acquisition;
  attachedSchema?: SerializedSchemaBinding;
  hasCreatedSchema?: boolean;
  schemaOrigin?: {
    schemaId: string;
    acquisitionIndex: number;
    schemaName: string;
    acquisitionName: string;
  };
  testDataNotes?: string;
  dicomFileBatchId?: string;
  attachedDataBatchId?: string;
}

export interface StoredSessionMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  storageSize: number;
}

export interface StoredSession {
  id: string;
  metadata: StoredSessionMetadata;
  items: SerializedWorkspaceItem[];
  schemaMetadata: SchemaMetadata;
  selectedId: string | null;
}

export interface StoredFileData {
  name: string;
  webkitRelativePath: string;
  type: string;
  lastModified: number;
  buffer: ArrayBuffer;
}

export interface StoredFileBatch {
  id: string;
  sessionId: string;
  batchId: string;
  files: StoredFileData[];
}

// --- SessionStorageManager ---

export class SessionStorageManager {
  private dbName = 'DicompareSessionsDB';
  private version = 1;
  private db: IDBDatabase | null = null;

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('sessionFiles')) {
          const fileStore = db.createObjectStore('sessionFiles', { keyPath: 'id' });
          fileStore.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
    });
  }

  async saveSession(session: StoredSession): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessions'], 'readwrite');
      const store = transaction.objectStore('sessions');
      const request = store.put(session);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getSession(id: string): Promise<StoredSession | null> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessions'], 'readonly');
      const store = transaction.objectStore('sessions');
      const request = store.get(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async getAllSessionMetadata(): Promise<StoredSessionMetadata[]> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessions'], 'readonly');
      const store = transaction.objectStore('sessions');
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const sessions = request.result as StoredSession[];
        const metadata = sessions.map(s => s.metadata);
        metadata.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        resolve(metadata);
      };
    });
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.db) await this.initialize();

    await this.deleteFileBatches(id);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessions'], 'readwrite');
      const store = transaction.objectStore('sessions');
      const request = store.delete(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async saveFileBatch(batch: StoredFileBatch): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessionFiles'], 'readwrite');
      const store = transaction.objectStore('sessionFiles');
      const request = store.put(batch);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getFileBatches(sessionId: string): Promise<StoredFileBatch[]> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessionFiles'], 'readonly');
      const store = transaction.objectStore('sessionFiles');
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  async deleteFileBatches(sessionId: string): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['sessionFiles'], 'readwrite');
      const store = transaction.objectStore('sessionFiles');
      const index = store.index('sessionId');
      const request = index.getAllKeys(sessionId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const keys = request.result;
        let remaining = keys.length;
        if (remaining === 0) {
          resolve();
          return;
        }
        for (const key of keys) {
          const deleteRequest = store.delete(key);
          deleteRequest.onerror = () => reject(deleteRequest.error);
          deleteRequest.onsuccess = () => {
            remaining--;
            if (remaining === 0) resolve();
          };
        }
      };
    });
  }

  async getSessionStorageSize(sessionId: string): Promise<number> {
    if (!this.db) await this.initialize();

    let size = 0;

    // Session data size
    const session = await this.getSession(sessionId);
    if (session) {
      size += new Blob([JSON.stringify(session)]).size;
    }

    // File batches size
    const batches = await this.getFileBatches(sessionId);
    for (const batch of batches) {
      for (const file of batch.files) {
        size += file.buffer.byteLength;
      }
    }

    return size;
  }
}

export const sessionStorageManager = new SessionStorageManager();
