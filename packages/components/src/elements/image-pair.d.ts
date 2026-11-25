import type { ExampleSelectorElement } from './example-selector.js';

export type ImageSlot = 'fixed' | 'moving';

export interface TemplateEntry {
  id: string;
  label: string;
  space: string;
  modality: string;
  brainExtracted: boolean;
  dimensionality: 2 | 3;
  dims: number[];
  spacingMm: number[];
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  license: string;
  licenseUrl: string;
  citation: { title: string; reference: string; doi?: string; url?: string };
}

export interface TemplateCatalogue {
  schema_version: 1;
  consumers: Record<string, { ids?: string[]; dimensionality?: 2 | 3 }>;
  templates: TemplateEntry[];
}

export interface ImageCandidate {
  name: string;
  file?: File;
  template?: TemplateEntry;
  brainExtracted?: boolean;
  [key: string]: unknown;
}

export interface ImageDescription {
  name: string;
  dims?: number[];
  spacingMm?: number[];
  dimensionality?: number;
  note?: string;
  brainExtracted?: boolean;
}

export interface ImageSlotState {
  candidate: ImageCandidate;
  series: ImageCandidate[];
  index: number;
  image: ImageDescription;
  locked?: boolean;
}

export interface ImagePairChange {
  slot: ImageSlot;
  fixed: ImageSlotState | null;
  moving: ImageSlotState | null;
  ready: boolean;
  error: string;
}

export interface ImagePairConfig {
  id?: string;
  examples?: unknown[];
  templates?: TemplateEntry[];
  lockedFixed?: TemplateEntry;
  slotHelp?: Partial<Record<ImageSlot, string>>;
  slotLabels?: Partial<Record<ImageSlot, string>>;
  exampleRoles?: Partial<Record<ImageSlot, string>>;
  showFolder?: boolean;
  read?: (files: File[], context: { slot: ImageSlot; signal?: AbortSignal }) => ImageCandidate[] | Promise<ImageCandidate[]>;
  open: (slot: ImageSlot, candidate: ImageCandidate, context: { signal?: AbortSignal }) => ImageDescription | Promise<ImageDescription>;
  clear?: (slot: ImageSlot) => void | Promise<void>;
  validatePair?: (fixed: ImageSlotState, moving: ImageSlotState) => string | null | undefined;
  perform?: <T>(message: string, task: (signal?: AbortSignal) => Promise<T>) => Promise<T>;
  onChange?: (change: ImagePairChange) => void;
  onStatus?: (message: string, error?: boolean) => void;
  fetchTemplate?: (entry: TemplateEntry, context: { signal?: AbortSignal }) => Promise<File>;
}

export interface ImagePairElement extends HTMLElement, Omit<ImagePairConfig, 'id'> {
  disabled: boolean;
  readonly fixed: ImageSlotState | null;
  readonly moving: ImageSlotState | null;
  readonly ready: boolean;
  readonly error: string;
  readonly exampleControl: ExampleSelectorElement | undefined;
  load(slot: ImageSlot, files: File[] | Promise<File[]>): Promise<void>;
  use(slot: ImageSlot, candidate: ImageCandidate): Promise<void>;
  loadWithin(slot: ImageSlot, files: File[] | Promise<File[]>, signal?: AbortSignal): Promise<void>;
  useWithin(slot: ImageSlot, candidate: ImageCandidate, signal?: AbortSignal): Promise<void>;
  reset(slot: ImageSlot): void;
  swap(): Promise<void>;
}

export const IMAGE_SLOTS: readonly ImageSlot[];
export function defineImagePair(view?: Window): CustomElementConstructor;
export function createImagePair(config: ImagePairConfig, doc?: Document): ImagePairElement;
export function fetchTemplateFile(entry: TemplateEntry, options?: { signal?: AbortSignal; window?: Window; fetch?: typeof fetch; cache?: string | null }): Promise<File>;

declare global {
  interface HTMLElementTagNameMap {
    'nd-image-pair': ImagePairElement;
  }
}
