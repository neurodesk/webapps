export const HANDOFF_TTL_MS: number;

export interface HandoffSource {
  app: string;
  title: string;
}

export interface HandoffEntry {
  id: string;
  createdAt: number;
  target: string;
  source: HandoffSource;
  /** SHA-256 of the secret the sending tab keeps in sessionStorage. */
  proof: string;
  files: { name: string; type: string; blob: Blob }[];
}

export function handoffId(hash: string): string | null;
export function withoutHandoff(hash: string): string;
export function isExpired(entry: Pick<HandoffEntry, 'createdAt'>, now?: number): boolean;
export function appPath(baseURI: string): string;
export function sweepHandoffs(): Promise<void>;
export function sendHandoff(options: { target: string; source: HandoffSource; files: File[]; document?: Document; signal?: AbortSignal }): Promise<void>;
export function takeHandoff(options?: { document?: Document }): Promise<{ source: HandoffSource; files: File[] } | null>;
