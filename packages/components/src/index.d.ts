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

export * from './elements/index.js';
