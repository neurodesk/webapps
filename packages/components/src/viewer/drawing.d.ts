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
  setColormap(name: string): void;
  volumeOpacity(index: number): number;
  setVolumeOpacity(index: number, opacity: number): Promise<void>;
  /** An uncompressed uint8 NIfTI on the base image's grid. */
  export(): Promise<Uint8Array>;
}

export function clampBrushSize(size: number): number;
export function maskToUint8Nifti(source: NiftiSource): Promise<Uint8Array>;
export function distinctLabels(source: NiftiSource): Promise<number[]>;
export function editedFileName(name: string): string;
export function createDrawingAdapter(nv: object): DrawingAdapter;
