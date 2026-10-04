import type { EditTool } from '../viewer/drawing.js';

export interface MaskEditorOptions {
  /** A NiiVue 0.x or 1.0 instance whose first volume is the image the mask was made on. */
  nv: object;
  onApply?(stage: string, edited: File, context: { original: File }): void | Promise<void>;
  onCancel?(stage: string): void;
  /** Failures from the toolbar's Apply and Cancel buttons, which have no caller to reject to. */
  onError?(stage: string, error: unknown): void;
  /** Names for label values, shown as `value — name` in the Label select. */
  labelNames?: Record<number, string>;
  doc?: Document;
}

export interface DrawingColormap {
  R: number[];
  G: number[];
  B: number[];
  A?: number[];
  I?: number[];
  labels?: string[];
}

export interface MaskEditStart {
  stage: string;
  file: File;
  /** Shown as `Editing <label>`; defaults to the stage. */
  label?: string;
  /** The result's overlay, hidden while its drawing is edited and restored afterwards. */
  overlayIndex?: number | null;
  /** A NiiVue drawing colormap for the labels: a registered name, or a colormap object. */
  colormap?: string | DrawingColormap | null;
}

export type MaskEditSession =
  | { state: 'idle' }
  | { state: 'opening'; stage: string }
  | {
    state: 'editing';
    stage: string;
    file: File;
    label: string;
    labelValues: number[];
    choices: number[];
    tool: EditTool;
    value: number;
    brush: number;
    overlay: { index: number; opacity: number } | null;
  }
  | { state: 'applying'; stage: string };

export interface MaskEditorElement extends HTMLElement {
  readonly session: MaskEditSession;
  configure(options: Omit<MaskEditorOptions, 'doc'>): void;
  /** Resolves `false` when cancelled while the mask loads; rejects when NiiVue refuses the mask. */
  start(options: MaskEditStart): Promise<boolean>;
  /** The edited file, or `null` when no session is open. */
  apply(): Promise<File | null>;
  cancel(): Promise<void>;
}

export function defineMaskEditor(view?: Window): CustomElementConstructor;
export function createMaskEditor(options: MaskEditorOptions): MaskEditorElement;

declare global {
  interface HTMLElementTagNameMap {
    'nd-mask-editor': MaskEditorElement;
  }
  interface HTMLElementEventMap {
    'nd-mask-edit-start': CustomEvent<{ stage: string; message: string }>;
    'nd-mask-edit-apply': CustomEvent<{ stage: string }>;
    'nd-mask-edit-cancel': CustomEvent<{ stage: string }>;
    'nd-mask-edit-error': CustomEvent<{ stage: string; error: unknown }>;
  }
}
