export interface StageResult {
  description?: string;
  visible?: boolean;
  viewable?: boolean;
  [key: string]: unknown;
}

export interface ResultListOptions<Result extends StageResult = StageResult> {
  element?: string | HTMLElement | null;
  stageLabels?: Record<string, string>;
  onView?(stage: string, result: Result | undefined): void;
  onVisibilityChange?(stage: string, visible: boolean, result: Result, input: HTMLInputElement): void;
  onDownload?(stage: string, result: Result | undefined): void;
}

export interface ResultListElement<Result extends StageResult = StageResult> extends HTMLElement {
  stageLabels: Record<string, string>;
  render(results?: Record<string, Result>, stageOrder?: string[]): void;
}

export function defineResultList(view?: Window): CustomElementConstructor;
export function createResultList<Result extends StageResult = StageResult>(options?: ResultListOptions<Result>, doc?: Document): ResultListElement<Result>;

declare global {
  interface HTMLElementTagNameMap {
    'nd-result-list': ResultListElement;
  }
}
