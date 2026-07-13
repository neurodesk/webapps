import React, { createContext, useContext, ReactNode } from 'react';
import { useFileProcessing, UseFileProcessingReturn, ProcessingTarget } from '../hooks/useFileProcessing';
import { ProcessingProgress } from './workspace/types';

export type { ProcessingTarget };
export type { ProcessingProgress };

interface ProcessingContextType extends UseFileProcessingReturn {}

const ProcessingContext = createContext<ProcessingContextType | undefined>(undefined);

interface ProcessingProviderProps {
  children: ReactNode;
}

export const ProcessingProvider: React.FC<ProcessingProviderProps> = ({ children }) => {
  const processing = useFileProcessing();

  return (
    <ProcessingContext.Provider value={processing}>
      {children}
    </ProcessingContext.Provider>
  );
};

export function useProcessing(): ProcessingContextType {
  const context = useContext(ProcessingContext);
  if (context === undefined) {
    throw new Error('useProcessing must be used within a ProcessingProvider');
  }
  return context;
}
