export interface ViewerToolbarOptions {
  views?: false | { id: string; label: string; active?: boolean; disabled?: boolean; hidden?: boolean; buttonId?: string; onClick?(event: MouseEvent): void }[];
  viewsLabel?: string;
  window?: boolean;
  overlay?: boolean;
  colormap?: boolean;
  download?: boolean;
  screenshot?: boolean;
  actions?: HTMLElement[];
}

export interface ToolbarControls {
  windowMin: HTMLInputElement;
  windowMax: HTMLInputElement;
  rangeMin: HTMLInputElement;
  rangeMax: HTMLInputElement;
  rangeSelected: HTMLDivElement;
  resetWindow: HTMLButtonElement;
  overlayOpacityControl: HTMLLabelElement;
  overlayOpacity: HTMLInputElement;
  overlayOpacityValue: HTMLSpanElement;
  colormapSelect: HTMLSelectElement;
  downloadCurrentVolume: HTMLButtonElement;
  screenshotViewer: HTMLButtonElement;
}

export interface ViewerToolbarElement extends HTMLElement {
  options: ViewerToolbarOptions;
  readonly viewTabs: HTMLDivElement;
  readonly actions: HTMLDivElement;
  control<K extends keyof ToolbarControls>(name: K): ToolbarControls[K] | null;
  setActive(id: string): void;
}

export function defineViewerToolbar(view?: Window): CustomElementConstructor;
export function createViewerToolbar(config?: ViewerToolbarOptions, doc?: Document): ViewerToolbarElement;

declare global {
  interface HTMLElementTagNameMap {
    'nd-viewer-toolbar': ViewerToolbarElement;
  }
}
