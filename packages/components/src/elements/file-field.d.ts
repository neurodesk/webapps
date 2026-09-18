export interface FileFieldConfig {
  id?: string;
  rootId?: string;
  name?: string;
  text?: string;
  html?: string;
  label?: string;
  kind?: 'image' | 'model' | 'surface' | 'protocol' | 'gradients' | 'metadata' | 'dataset';
  multiple?: boolean;
  accept?: string;
  directory?: boolean;
  disabled?: boolean;
}

export interface FileFieldElement extends HTMLElement {
  readonly input: HTMLInputElement;
  readonly text: HTMLElement;
  disabled: boolean;
  onFiles(handler: (files: Promise<File[]>) => void): this;
  setText(value: string): void;
  setHasFiles(value: boolean): void;
}

export function defineFileField(view?: Window): CustomElementConstructor;
export function createFileField(config?: FileFieldConfig, doc?: Document): FileFieldElement;

declare global {
  interface HTMLElementTagNameMap {
    'nd-file-field': FileFieldElement;
  }
}
