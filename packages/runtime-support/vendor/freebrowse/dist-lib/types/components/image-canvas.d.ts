import { NiiVue } from "@niivue/niivue";
interface ImageCanvasProps {
    viewMode: "axial" | "coronal" | "sagittal" | "ACS" | "ACSR" | "render";
    nvRef: NiiVue;
}
export default function ImageCanvas({ viewMode, nvRef }: ImageCanvasProps): import("react/jsx-runtime").JSX.Element;
export {};
