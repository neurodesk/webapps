import NiiVue from "@niivue/niivue";
/**
 * Mesh scalar-overlay layer handlers. Command-only: handlers issue nv.* layer
 * commands (addMeshLayer/removeMeshLayer/setMeshLayerProperty), which emit
 * meshUpdated -> the event adapter bumps layerVersion. getLayers re-reads
 * nv.meshes[i].layers at render, so the UI follows without imperative writes.
 * Layers are addressed by (meshIndex, layerIndex) — niivue-mono meshes have no id.
 */
export declare function useMeshLayers(nvRef: React.RefObject<NiiVue | null>): {
    layerFileInputRef: import("react").RefObject<HTMLInputElement | null>;
    getLayers: () => import("@niivue/niivue").NVMeshLayer[];
    addLayerFromFile: (file: File) => Promise<void>;
    removeLayer: (layerIndex: number) => void;
    handleLayerOpacityChange: (value: number) => void;
    handleLayerCalMinChange: (value: number) => void;
    handleLayerCalMaxChange: (value: number) => void;
    handleLayerColormapChange: (colormap: string) => Promise<void>;
    handleLayerUseNegativeCmapChange: (checked: boolean) => Promise<void>;
    handleAddLayerFiles: () => void;
    handleLayerFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
};
