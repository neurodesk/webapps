import type { HandoffSource } from './index.js';

/** Opens files another app sent here, or returns null when a newer file choice, drop or example supersedes it. */
export function receiveHandoff(document?: Document): Promise<{ source: HandoffSource; files: File[] } | null>;
