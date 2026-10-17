import type { NiiVue } from "@niivue/niivue";
/**
 * Surface (mesh) handlers. Command-only: handlers issue nv.* commands and the
 * derived `surfaces` list follows via the event adapter (which rebuilds it from
 * nv.meshes on meshLoaded/meshRemoved/meshUpdated). Handlers never write the
 * surfaces slice directly.
 */
export declare function useSurfaces(nvRef: React.RefObject<NiiVue | null>, debouncedGLUpdate: () => void): {
    updateSurfaceDetails: () => void;
    toggleSurfaceVisibility: (surfaceIndex: number) => void;
    removeSurface: (surfaceIndex: number) => void;
    handleRemoveSurfaceClick: (surfaceIndex: number) => void;
    handleSurfaceOpacityChange: (newOpacity: number) => void;
    handleSurfaceColorChange: (hexColor: string) => void;
    handleMeshShaderChange: (shaderName: string) => void;
};
