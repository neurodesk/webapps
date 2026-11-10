export interface ExampleFile {
  role: string;
  name: string;
  url: string;
  sha256?: string;
  bytes?: number;
}

export interface AppExample {
  id: string;
  label: string;
  description: string;
  expectedResult: string;
  files: ExampleFile[];
  /** Cycle through these catalogue IDs after successful loads; retries keep the same case. */
  rotation?: string[];
}

export interface ExampleLoadContext {
  signal: AbortSignal;
  fetchFiles(): Promise<File[]>;
  assertCurrent(): void;
}

export interface ExampleSelectorOptions<T extends AppExample = AppExample> {
  examples: T[];
  onLoad(example: T, context: ExampleLoadContext): Promise<void>;
  onStatus?(message: string, error: boolean): void;
  scope?: HTMLElement;
  /** False lists only the examples, for an owner with its own picker for every slot. */
  fileActions?: boolean;
}

export interface ExampleSelectorElement<T extends AppExample = AppExample> extends HTMLElement {
  examples: T[];
  onLoad: ExampleSelectorOptions<T>['onLoad'];
  onStatus: NonNullable<ExampleSelectorOptions<T>['onStatus']>;
  scope: HTMLElement | undefined;
  fileActions: boolean;
  readonly uploadScope: HTMLElement | undefined;
  disabled: boolean;
  readonly select: HTMLSelectElement;
  cancel(): void;
  reset(): void;
  setDisabled(value: boolean): void;
  destroy(): void;
}

export function defineExampleSelector(view?: Window): CustomElementConstructor;
export function createExampleSelector<T extends AppExample>(options: ExampleSelectorOptions<T>, doc?: Document): ExampleSelectorElement<T>;

declare global {
  interface HTMLElementTagNameMap {
    'nd-example-selector': ExampleSelectorElement;
  }
}
