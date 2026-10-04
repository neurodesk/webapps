export type ShellControlAction = 'about' | 'cite' | 'privacy' | 'standalone';
export type ShellTarget = string | Element;
export type ShellTargetSet = ShellTarget | readonly ShellTarget[];
export type ShellControlsContract = Partial<Record<ShellControlAction, ShellTargetSet>>;

export interface ImagingWorkspaceConfig {
  document?: Document;
  root?: string | Element;
  controls: string | Element;
  viewer: string | Element;
  status: string | Element;
  title?: string;
  subtitle?: string;
  mark?: string;
  moreAppsHref?: string;
  controlsContract?: ShellControlsContract;
}

export function mountImagingWorkspace(config: ImagingWorkspaceConfig): HTMLElement;

// ---- Workflow vocabulary builders (ui) ----
export function renderSidebarSection(config?: {
  id?: string;
  title?: string;
  collapsed?: boolean;
  disabled?: boolean;
  content?: Node | (Node | string | null | undefined | false)[] | string;
  badge?: string | number;
  badgeClassName?: string;
}, doc?: Document): {
  root: HTMLDetailsElement;
  title: HTMLElement;
  content: HTMLDivElement;
  setDisabled(disabled: boolean): void;
  setBadge(text: string, className?: string): void;
};
export function bindFileDrop(target: Element, handler: ((files: Promise<File[]>) => void) | null, doc?: Document, isDisabled?: () => boolean): { handler: ((files: Promise<File[]>) => void) | null; destroy(): void };

export interface InfoDialog {
  root: HTMLDialogElement;
  title: HTMLHeadingElement;
  body: HTMLDivElement;
  open(heading: string, content?: string | Node | Node[] | null, options?: { wide?: boolean; classes?: Record<string, boolean> }): HTMLDialogElement;
  close(): void;
  setContent(content?: string | Node | Node[] | null): void;
}
export function createInfoDialog(config?: { id?: string; titleId?: string; bodyId?: string; parent?: Element }, doc?: Document): InfoDialog;
export function renderCommand(config: { id?: string; command: string; label?: string; onCopy?(copied: boolean, command: string): void }, doc?: Document): { root: HTMLDivElement; code: HTMLElement; button: HTMLButtonElement };

export function bindInfoTooltips(root?: ParentNode): void;
export function renderInfoIcon(text: string, config?: { label?: string; id?: string }, doc?: Document): HTMLSpanElement;
export function bindSectionDisclosure(section: Element, root?: ParentNode): MutationObserver;
export interface ConsoleResize {
  handle: HTMLDivElement;
  getHeight(): number;
  getMax(): number;
  setHeight(height: number): number;
  reset(): void;
  destroy(): void;
}
/** Adds a drag and keyboard resize separator to an open console; the height survives collapse. */
export function bindConsoleResize(container: HTMLElement, options?: { min?: number; max?: number; reserve?: number; label?: string }): ConsoleResize;
export function unbindConsoleResize(container: HTMLElement): void;
export const CONSOLE_MIN_HEIGHT: number;
export const CONSOLE_VIEWER_RESERVE: number;

/** Drives footer#status: message, progress, elapsed time and the cancel ×. */
export class ProgressManager {
  constructor(options?: {
    barElement?: Element | null; progressBarId?: string;
    textElement?: Element | null; statusTextId?: string;
    elapsedElement?: Element | null; elapsedId?: string;
    cancelElement?: HTMLButtonElement | null; cancelId?: string;
    animationSpeed?: number;
  });
  setProgress(value: number, text?: string | null): void;
  setIndeterminate(text?: string): void;
  setText(text: string): void;
  setCancellable(cancellable: boolean): void;
  startTimer(): void;
  stopTimer(clear?: boolean): void;
  begin(text?: string, options?: { cancellable?: boolean }): void;
  end(text: string, options?: { success?: boolean }): void;
  reset(text?: string): void;
}

export * from './elements/index.js';
