import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "greedy",
  base: "./",
  plugins: [isolationFallback()],
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
});
