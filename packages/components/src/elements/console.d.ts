export interface ConsoleLog {
  log(message: unknown, level?: 'info' | 'success' | 'warning' | 'error'): void;
  clear(): void;
  getText(): string;
  copyToClipboard(): Promise<boolean>;
}

export interface ConsoleOptions {
  id?: string;
  outputId?: string;
  outputLabel?: string;
  title?: string;
  collapsed?: boolean;
  copy?: boolean;
  clear?: boolean;
  copyId?: string;
  clearId?: string;
  mirrorToConsole?: boolean;
  maxLines?: number;
  /** Add the drag and keyboard separator that lets the user enlarge the open log. */
  resizable?: boolean;
  /** Two or more logs behind tabs in the header, e.g. analysis and technical. */
  channels?: Array<string | { id: string; label?: string }>;
  /** Channel shown first; defaults to the first declared. */
  channel?: string;
}

type ConsoleLevel = 'info' | 'success' | 'warning' | 'error';

export interface ConsoleElement extends HTMLElement {
  collapsed: boolean;
  resizable: boolean;
  /** The visible log: the only one, or the selected channel's. */
  readonly output: HTMLDivElement;
  readonly console: ConsoleLog;
  readonly channels: string[];
  readonly activeChannel: string;
  open(): void;
  close(): void;
  selectChannel(id: string): void;
  channel(id: string): ConsoleLog;
  /** Without `channel` the entry goes to the first channel. An error opens the log on its channel. */
  log(message: unknown, level?: ConsoleLevel, channel?: string): void;
  /** Without `channel`, the selected channel. */
  clear(channel?: string): void;
  getText(channel?: string): string;
}

export function defineConsole(view?: Window): CustomElementConstructor;
export function createConsole(config?: ConsoleOptions, doc?: Document): ConsoleElement;

declare global {
  interface HTMLElementTagNameMap {
    'nd-console': ConsoleElement;
  }
}
