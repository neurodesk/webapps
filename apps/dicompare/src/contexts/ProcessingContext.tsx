import React, { createContext, useContext, ReactNode } from 'react';
import { useFileProcessing, UseFileProcessingReturn } from '../hooks/useFileProcessing';

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
