import type { ComputeClient, ComputeClientOptions, ComputeInfo } from '../compute/index.js';

export type ComputeConnectionState = 'idle' | 'connecting' | 'connected' | 'simulated' | 'error' | 'info';

export interface ComputeConnectionConfig {
  id?: string;
  storageKey?: string;
  disabled?: boolean;
  autodetect?: boolean;
  fetch?: typeof fetch;
  createClient?(options: ComputeClientOptions): ComputeClient;
}

export interface ComputeConnectionElement extends HTMLElement {
  disabled: boolean;
  address: string;
  token: string;
  readonly state: ComputeConnectionState;
  readonly client: ComputeClient | null;
  readonly info: ComputeInfo | null;
  readonly addressInput: HTMLInputElement;
  readonly tokenInput: HTMLInputElement;
  readonly message: HTMLParagraphElement;
  configure(config: ComputeConnectionConfig): this;
  detect(): Promise<boolean>;
  connect(): Promise<ComputeClient | null>;
  disconnect(): void;
  setDisabled(value: boolean): void;
}

export function defineComputeConnection(view?: Window): CustomElementConstructor;
export function createComputeConnection(config?: ComputeConnectionConfig, doc?: Document): ComputeConnectionElement;
