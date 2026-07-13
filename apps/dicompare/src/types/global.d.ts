// Global type declarations for external libraries

declare global {
  interface Window {
    loadPyodide: (config?: {
      indexURL?: string;
      packageCacheDir?: string;
      lockFileURL?: string;
    }) => Promise<{
      runPython: (code: string) => any;
      runPythonAsync: (code: string) => Promise<any>;
      globals: {
        get: (name: string) => any;
        set: (name: string, value: any) => void;
      };
      loadPackage: (packages: string | string[]) => Promise<void>;
    }>;
  }
}

export {};