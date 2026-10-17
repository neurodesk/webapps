import type { NiiVue } from "@niivue/niivue";
export declare function useAiSession(nvRef: React.RefObject<NiiVue | null>): {
    refreshSessions: () => Promise<void>;
    handleNewSession: (sessionName: string) => Promise<void>;
    handleLoadSession: (sessionId: string) => Promise<void>;
    handleRunSegmentation: (mlId: string, labelValue: number) => Promise<void>;
    handleExitAndSaveSession: () => Promise<void>;
    handleExitAndDeleteSession: () => Promise<void>;
};
