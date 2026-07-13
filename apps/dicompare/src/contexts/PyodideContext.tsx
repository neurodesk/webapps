import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { dicompareWorkerAPI } from '../services/DicompareWorkerAPI';

export interface PyodideStatus {
  isLoading: boolean;
  isReady: boolean;
  progress: number;
  currentOperation: string;
  error: string | null;
}

interface PyodideContextType {
  status: PyodideStatus;
  ensureReady: () => Promise<void>;
}

const PyodideContext = createContext<PyodideContextType | null>(null);

export const usePyodide = () => {
  const context = useContext(PyodideContext);
  if (!context) {
    throw new Error('usePyodide must be used within a PyodideProvider');
  }
  return context;
};

export const PyodideProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<PyodideStatus>({
    isLoading: false,
    isReady: false,
    progress: 0,
    currentOperation: '',
    error: null,
  });

  // Use ref to track initialization state to avoid stale closures
  const initializingRef = useRef(false);
  const initializedRef = useRef(false);

  const ensureReady = useCallback(async () => {
    // Check refs to prevent double initialization
    if (initializedRef.current || initializingRef.current) {
      return;
    }

    initializingRef.current = true;

    setStatus(prev => ({
      ...prev,
      isLoading: true,
      progress: 0,
      currentOperation: 'Starting Python environment...',
      error: null,
    }));

    try {
      await dicompareWorkerAPI.ensureInitialized((progress) => {
        setStatus(prev => ({
          ...prev,
          progress: progress.percentage,
          currentOperation: progress.currentOperation || 'Loading...',
        }));
      });

      initializedRef.current = true;
      setStatus({
        isLoading: false,
        isReady: true,
        progress: 100,
        currentOperation: 'Ready',
        error: null,
      });
    } catch (error) {
      initializingRef.current = false;
      setStatus(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to initialize',
      }));
    }
  }, []);

  // Start loading immediately when provider mounts
  useEffect(() => {
    // Check if already initialized
    if (dicompareWorkerAPI.isInitialized()) {
      initializedRef.current = true;
      setStatus({
        isLoading: false,
        isReady: true,
        progress: 100,
        currentOperation: 'Ready',
        error: null,
      });
      return;
    }

    // Start background initialization
    ensureReady();
  }, [ensureReady]);

  return (
    <PyodideContext.Provider value={{ status, ensureReady }}>
      {children}
    </PyodideContext.Provider>
  );
};
