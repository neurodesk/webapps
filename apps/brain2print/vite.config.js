import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "brain2print",
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: {
    exclude: ["@niivue/dcm2niix", "@niivue/niimath"],
  },
});
