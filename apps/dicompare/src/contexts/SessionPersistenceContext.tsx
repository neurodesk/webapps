import React, { createContext, useContext, useCallback, useEffect, useState, useRef, ReactNode } from 'react';
import { useItemManagement } from './ItemManagementContext';
import { useSchemaMetadata } from './SchemaMetadataContext';
import { useSchemaService } from '../hooks/useSchemaService';
import { dicomFileCache } from '../utils/dicomFileCache';
import {
  sessionStorageManager,
  StoredSessionMetadata,
  StoredSession,
} from '../services/SessionStorageManager';
import {
  serializeWorkspaceItems,
  collectFileBatchIds,
  serializeFileBatch,
  deserializeWorkspaceItems,
  restoreFileBatches,
  generateSessionName,
} from '../utils/sessionSerializer';

interface SessionPersistenceContextType {
  activeSessionId: string | null;
  sessions: StoredSessionMetadata[];
  isLoadingSessions: boolean;
  loadSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  refreshSessionList: () => Promise<void>;
  endSession: () => void;
}

const SessionPersistenceContext = createContext<SessionPersistenceContextType | undefined>(undefined);

interface SessionPersistenceProviderProps {
  children: ReactNode;
}

export const SessionPersistenceProvider: React.FC<SessionPersistenceProviderProps> = ({ children }) => {
  const { items, setItems, clearItems, selectItem } = useItemManagement();
  const { schemaMetadata, setSchemaMetadata } = useSchemaMetadata();
  const { getUnifiedSchema } = useSchemaService();

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<StoredSessionMetadata[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);

  // Refs to avoid re-render loops and track internal state
  const activeSessionIdRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedBatchIdsRef = useRef<Set<string>>(new Set());
  const isRestoringRef = useRef(false);
  const itemsRef = useRef(items);
  const schemaMetadataRef = useRef(schemaMetadata);

  // Keep refs in sync
  itemsRef.current = items;
  schemaMetadataRef.current = schemaMetadata;

  // Load session list on mount
  useEffect(() => {
    refreshSessionList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSessionList = useCallback(async () => {
    setIsLoadingSessions(true);
    try {
      const allSessions = await sessionStorageManager.getAllSessionMetadata();
      setSessions(allSessions);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setIsLoadingSessions(false);
    }
  }, []);

  const performSave = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;

    const currentItems = itemsRef.current;
    const currentMetadata = schemaMetadataRef.current;

    try {
      const serializedItems = serializeWorkspaceItems(currentItems);
      const sessionName = generateSessionName(currentMetadata);

      // Save new file batches (only those not already saved)
      const allBatchIds = collectFileBatchIds(currentItems);
      const newBatchIds = allBatchIds.filter(id => !savedBatchIdsRef.current.has(id));

      for (const batchId of newBatchIds) {
        const batch = await serializeFileBatch(sessionId, batchId);
        if (batch) {
          await sessionStorageManager.saveFileBatch(batch);
          savedBatchIdsRef.current.add(batchId);
        }
      }

      // Estimate storage size
      const itemsJson = JSON.stringify(serializedItems);
      let storageSize = new Blob([itemsJson]).size;

      // Add file sizes from all saved batches
      for (const batchId of allBatchIds) {
        const files = dicomFileCache.get(batchId);
        if (files) {
          for (const file of files) {
            storageSize += file.size;
          }
        }
      }

      const now = new Date().toISOString();
      const session: StoredSession = {
        id: sessionId,
        metadata: {
          id: sessionId,
          name: sessionName,
          createdAt: now,
          updatedAt: now,
          itemCount: currentItems.length,
          storageSize,
        },
        items: serializedItems,
        schemaMetadata: currentMetadata,
        selectedId: null,
      };

      // Preserve original createdAt if session already exists
      const existing = await sessionStorageManager.getSession(sessionId);
      if (existing) {
        session.metadata.createdAt = existing.metadata.createdAt;
      }

      await sessionStorageManager.saveSession(session);
      await refreshSessionList();
    } catch (err) {
      console.error('Failed to save session:', err);
    }
  }, [refreshSessionList]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      performSave();
    }, 1000);
  }, [performSave]);

  // Watch items and schemaMetadata for auto-save
  useEffect(() => {
    if (isRestoringRef.current) return;

    const hasContent = items.length > 0 ||
      schemaMetadata.name !== '' ||
      schemaMetadata.authors.length > 0 ||
      schemaMetadata.description !== '';

    if (!hasContent) {
      isDirtyRef.current = false;
      return;
    }

    if (!activeSessionIdRef.current) {
      const newId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);
      savedBatchIdsRef.current = new Set();
    }

    isDirtyRef.current = true;
    scheduleSave();
  }, [items, schemaMetadata, scheduleSave]);

  const loadSession = useCallback(async (sessionId: string) => {
    isRestoringRef.current = true;
    try {
      const session = await sessionStorageManager.getSession(sessionId);
      if (!session) {
        console.error('Session not found:', sessionId);
        return;
      }

      // Load file batches and restore to in-memory cache
      const fileBatches = await sessionStorageManager.getFileBatches(sessionId);
      dicomFileCache.clear();
      restoreFileBatches(fileBatches);

      // Reconstruct items with schema bindings
      const restoredItems = deserializeWorkspaceItems(
        session.items,
        getUnifiedSchema
      );

      // Set state
      clearItems();
      setSchemaMetadata(session.schemaMetadata);
      setItems(restoredItems);
      if (restoredItems.length > 0) {
        selectItem(restoredItems[0].id);
      }

      // Track which batches are already saved
      savedBatchIdsRef.current = new Set(fileBatches.map(b => b.batchId));
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      isDirtyRef.current = true;
    } catch (err) {
      console.error('Failed to load session:', err);
    } finally {
      // Delay clearing restore flag so the auto-save effect skips the state updates
      setTimeout(() => {
        isRestoringRef.current = false;
      }, 200);
    }
  }, [getUnifiedSchema, clearItems, setItems, setSchemaMetadata, selectItem]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await sessionStorageManager.deleteSession(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
        isDirtyRef.current = false;
        savedBatchIdsRef.current = new Set();
      }
      await refreshSessionList();
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, [refreshSessionList]);

  const endSession = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // Flush a final save before ending
    if (isDirtyRef.current && activeSessionIdRef.current) {
      performSave();
    }
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    isDirtyRef.current = false;
    savedBatchIdsRef.current = new Set();
  }, [performSave]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  return (
    <SessionPersistenceContext.Provider value={{
      activeSessionId,
      sessions,
      isLoadingSessions,
      loadSession,
      deleteSession,
      refreshSessionList,
      endSession,
    }}>
      {children}
    </SessionPersistenceContext.Provider>
  );
};

export function useSessionPersistence(): SessionPersistenceContextType {
  const context = useContext(SessionPersistenceContext);
  if (context === undefined) {
    throw new Error('useSessionPersistence must be used within a SessionPersistenceProvider');
  }
  return context;
}
