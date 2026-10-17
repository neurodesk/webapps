import { SchemaMetadata } from '../types/schema';
import Ajv2020 from 'ajv/dist/2020';
// Bundled from the pinned dicompare version (src/version.ts) so schema
// validation matches the library and needs no network. Regenerate with:
//   npm run sync:metaschema
import bundledMetaschema from '../data/metaschema.json';

interface StoredSchema {
  metadata: SchemaMetadata;
  content: string;
}


export class SchemaCacheManager {
  private dbName = 'DicompareSchemasDB';
  private version = 1;
  private db: IDBDatabase | null = null;
  private metaschema: object | null = null;
  private ajv: Ajv2020 | null = null;

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

        if (!db.objectStoreNames.contains('schemas')) {
          const store = db.createObjectStore('schemas', { keyPath: 'metadata.id' });
          store.createIndex('filename', 'metadata.filename', { unique: false });
          store.createIndex('uploadDate', 'metadata.uploadDate', { unique: false });
        }
      };
    });
  }

  async storeSchema(metadata: SchemaMetadata, content: string): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['schemas'], 'readwrite');
      const store = transaction.objectStore('schemas');

      const schema: StoredSchema = { metadata, content };
      const request = store.put(schema);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getSchema(id: string): Promise<StoredSchema | null> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['schemas'], 'readonly');
      const store = transaction.objectStore('schemas');
      const request = store.get(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async getAllSchemaMetadata(): Promise<SchemaMetadata[]> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['schemas'], 'readonly');
      const store = transaction.objectStore('schemas');
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const schemas = request.result as StoredSchema[];
        resolve(schemas.map(schema => schema.metadata));
      };
    });
  }

  async deleteSchema(id: string): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['schemas'], 'readwrite');
      const store = transaction.objectStore('schemas');
      const request = store.delete(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async updateSchemaMetadata(id: string, updates: Partial<SchemaMetadata>): Promise<void> {
    const schema = await this.getSchema(id);
    if (!schema) throw new Error(`Schema with id ${id} not found`);

    const updatedMetadata = { ...schema.metadata, ...updates };
    await this.storeSchema(updatedMetadata, schema.content);
  }

  /**
   * Load the DiCompare metaschema for validation.
   */
  private async loadMetaschema(): Promise<object> {
    if (!this.metaschema) {
      this.metaschema = bundledMetaschema;
    }
    return this.metaschema;
  }

  /**
   * Get or create the AJV validator instance.
   * Uses Ajv2020 which natively supports JSON Schema draft 2020-12.
   */
  private async getValidator(): Promise<Ajv2020> {
    if (this.ajv) {
      return this.ajv;
    }

    // Ajv2020 natively supports draft 2020-12 schemas
    this.ajv = new Ajv2020({
      allErrors: true,
      verbose: true,
      strict: false
    });
    return this.ajv;
  }

  /**
   * Validate JSON content against the DiCompare metaschema.
   * This can be called directly with content string.
   */
  async validateSchemaContent(content: string): Promise<{ isValid: boolean; error?: string }> {
    // First check if it's valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      return {
        isValid: false,
        error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Parse error'}`
      };
    }

    // Then validate against the metaschema
    try {
      const ajv = await this.getValidator();
      const metaschema = await this.loadMetaschema();
      const validate = ajv.compile(metaschema);
      const valid = validate(parsed);

      if (!valid && validate.errors) {
        const firstError = validate.errors[0];
        const path = firstError.instancePath || '(root)';
        const message = firstError.message || 'Unknown validation error';
        return {
          isValid: false,
          error: `Schema validation failed at ${path}: ${message}`
        };
      }

      return { isValid: true };
    } catch (validationError) {
      // If metaschema validation fails (e.g., can't load metaschema),
      // fall back to just JSON parse success with a warning
      console.warn('Metaschema validation unavailable, accepting valid JSON:', validationError);
      return { isValid: true };
    }
  }

  async validateSchemaFile(file: File): Promise<{ isValid: boolean; error?: string }> {
    try {
      const content = await this.readFileContent(file);

      if (file.name.endsWith('.json')) {
        return this.validateSchemaContent(content);
      } else if (file.name.endsWith('.py')) {
        if (content.includes('def ') || content.includes('class ')) {
          return { isValid: true };
        }
        return { isValid: false, error: 'Python file must contain function or class definitions' };
      }

      return { isValid: false, error: 'Unsupported file format. Only .json and .py files are supported.' };
    } catch (error) {
      return { isValid: false, error: `Invalid file format: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }

  async extractMetadataFromFile(file: File): Promise<Partial<SchemaMetadata>> {
    const content = await this.readFileContent(file);
    const baseMetadata: Partial<SchemaMetadata> = {
      filename: file.name,
      fileSize: file.size,
      format: file.name.endsWith('.py') ? 'python' : 'json',
      uploadDate: new Date().toISOString(),
    };

    try {
      if (file.name.endsWith('.json')) {
        const parsed = JSON.parse(content);
        return {
          ...baseMetadata,
          title: parsed.title || parsed.name || file.name,
          version: parsed.version || '1.0.0',
          authors: parsed.authors || [],
          description: parsed.description,
          acquisitionCount: parsed.acquisitions?.length || 0,
        };
      } else {
        const titleMatch = content.match(/title\s*=\s*["']([^"']+)["']/);
        const versionMatch = content.match(/version\s*=\s*["']([^"']+)["']/);
        const authorMatch = content.match(/authors?\s*=\s*\[([^\]]+)\]/);

        return {
          ...baseMetadata,
          title: titleMatch?.[1] || file.name,
          version: versionMatch?.[1] || '1.0.0',
          authors: authorMatch ? authorMatch[1].split(',').map(a => a.trim().replace(/["']/g, '')) : [],
          description: content.split('\n').find(line => line.includes('"""') || line.includes("'''"))?.replace(/["""''']/g, '').trim(),
        };
      }
    } catch {
      return baseMetadata;
    }
  }

  private readFileContent(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  async clearCache(): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['schemas'], 'readwrite');
      const store = transaction.objectStore('schemas');
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getCacheSize(): Promise<number> {
    const schemas = await this.getAllSchemaMetadata();
    return schemas.reduce((total, schema) => total + schema.fileSize, 0);
  }
}

export const schemaCacheManager = new SchemaCacheManager();