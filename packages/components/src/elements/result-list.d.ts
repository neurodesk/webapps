export interface StageResult {
  description?: string;
  visible?: boolean;
  viewable?: boolean;
  /** Renders an Edit button that opens the result in the mask editor. */
  editable?: boolean;
  /** Labels the row `… (edited)`. */
  edited?: boolean;
  [key: string]: unknown;
}

export interface ResultListOptions<Result extends StageResult = StageResult> {
  element?: string | HTMLElement | null;
  stageLabels?: Record<string, string>;
  onView?(stage: string, result: Result | undefined): void;
  onVisibilityChange?(stage: string, visible: boolean, result: Result, input: HTMLInputElement): void;
  onDownload?(stage: string, result: Result | undefined): void;
  onEdit?(stage: string, result: Result): void;
}

export interface ResultListElement<Result extends StageResult = StageResult> extends HTMLElement {
  stageLabels: Record<string, string>;
  render(results?: Record<string, Result>, stageOrder?: string[]): void;
  /** Disables every Edit button while an edit session is open. */
  setEditingEnabled(enabled: boolean): void;
}

export function defineResultList(view?: Window): CustomElementConstructor;
export function createResultList<Result extends StageResult = StageResult>(options?: ResultListOptions<Result>, doc?: Document): ResultListElement<Result>;

declare global {
  interface HTMLElementTagNameMap {
    'nd-result-list': ResultListElement;
  }
}
