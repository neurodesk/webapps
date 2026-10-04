export type EditTool = 'draw' | 'erase' | 'fill';
export type NiftiSource = Blob | ArrayBuffer | Uint8Array;

export const EDIT_TOOLS: readonly EditTool[];
export const BRUSH_SIZE: Readonly<{ min: number; max: number }>;

export interface DrawingAdapter {
  readonly enabled: boolean;
  /** `null` opens an empty drawing; otherwise the mask must share the base image's voxel grid. */
  open(source?: NiftiSource | null): Promise<boolean>;
  close(): void;
  setTool(tool: { tool: EditTool; label: number; brushSize: number }): void;
  undo(): void;
  setOpacity(opacity: number): void;
  /** A registered colormap name, or a colormap object registered for the drawing. */
  setColormap(colormap: string | { R: number[]; G: number[]; B: number[]; A?: number[]; I?: number[]; labels?: string[] }): void;
  volumeOpacity(index: number): number;
  setVolumeOpacity(index: number, opacity: number): Promise<void>;
  /** Uncompressed uint8 labels with the source mask's header and extensions, or the base header for an empty drawing. */
  export(): Promise<Uint8Array>;
}

export function clampBrushSize(size: number): number;
export function maskToUint8Nifti(source: NiftiSource): Promise<Uint8Array>;
export function distinctLabels(source: NiftiSource): Promise<number[]>;
export function editedFileName(name: string): string;
export function createDrawingAdapter(nv: object): DrawingAdapter;
