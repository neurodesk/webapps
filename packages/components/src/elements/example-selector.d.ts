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
  /** How a browser agent's tools load this example: see webmcp/examples.js. The selector ignores it. */
  automation?: ExampleAutomation;
}

export type ExampleAutomation =
  | { roles?: Record<string, string | null>; files?: Record<string, string | null>; reason?: string; unavailable?: undefined }
  | { unavailable: string };

export interface ExampleLoadContext {
  signal: AbortSignal;
  fetchFiles(): Promise<File[]>;
  assertCurrent(): void;
  /** Replaces the loaded status. Set inline to false when onStatus routes it to the footer. */
  setMessage(text: string, options?: { inline?: boolean }): void;
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
