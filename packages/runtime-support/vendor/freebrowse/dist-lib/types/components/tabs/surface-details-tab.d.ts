import type { NiiVue, NVMeshLayer } from "@niivue/niivue";
interface SurfaceDetailsTabProps {
    nvRef: React.RefObject<NiiVue | null>;
    onToggleVisibility: (index: number) => void;
    onRemoveSurface: (index: number) => void;
    onAddSurfaceFiles: () => void;
    onOpacityChange: (value: number) => void;
    onColorChange: (hexColor: string) => void;
    onShaderChange: (shaderName: string) => void;
    getLayers: () => NVMeshLayer[];
    onAddLayerFiles: () => void;
    onRemoveLayer: (index: number) => void;
    onLayerOpacityChange: (value: number) => void;
    onLayerCalMinChange: (value: number) => void;
    onLayerCalMaxChange: (value: number) => void;
    onLayerColormapChange: (colormap: string) => void;
    onLayerUseNegativeCmapChange: (checked: boolean) => void;
}
export default function SurfaceDetailsTab({ nvRef, onToggleVisibility, onRemoveSurface, onAddSurfaceFiles, onOpacityChange, onColorChange, onShaderChange, getLayers, onAddLayerFiles, onRemoveLayer, onLayerOpacityChange, onLayerCalMinChange, onLayerCalMaxChange, onLayerColormapChange, onLayerUseNegativeCmapChange, }: SurfaceDetailsTabProps): import("react/jsx-runtime").JSX.Element;
export {};
