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
}

export interface ConsoleElement extends HTMLElement {
  collapsed: boolean;
  readonly output: HTMLDivElement;
  readonly console: ConsoleLog;
  open(): void;
  close(): void;
  log(message: unknown, level?: 'info' | 'success' | 'warning' | 'error'): void;
  clear(): void;
  getText(): string;
}

export function defineConsole(view?: Window): CustomElementConstructor;
export function createConsole(config?: ConsoleOptions, doc?: Document): ConsoleElement;

declare global {
  interface HTMLElementTagNameMap {
    'nd-console': ConsoleElement;
  }
}
