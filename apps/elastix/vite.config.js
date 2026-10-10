import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
// ITK-Wasm and the OME-Zarr/TIFF readers stay out of dependency pre-bundling so
// the pipeline worker they create with new URL(..., import.meta.url) resolves.
export default neurodeskViteConfig({
  appId: "elastix",
  optimizeDeps: {
    exclude: [
      "itk-wasm",
      "@itk-wasm/elastix",
      "@itk-wasm/image-io",
      "@itk-wasm/transform-io",
      "@thewtex/zstddec",
      "@fideus-labs/ngff-zarr",
      "@fideus-labs/fiff",
    ],
  },
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
});
