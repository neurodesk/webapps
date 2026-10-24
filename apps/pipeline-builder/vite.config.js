import { readFile } from "node:fs/promises";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { loadCatalogContracts, neuroflowBundleFiles, neuroflowRegistryIndex } from "../../scripts/lib/neuroflow-bundle.mjs";

const TEMPLATES = ["t1-segmentation", "dwi-preprocessing"];

// The page publishes the catalog it edits as a NeuroFlow registry under neuroflow/:
// generated tools and their runtime, the template workflows, and the registry index.
async function catalogFiles() {
  const { files } = await neuroflowBundleFiles(await loadCatalogContracts({ exclude: ["pipeline-builder"] }));
  for (const name of TEMPLATES) {
    files.set(`workflows/${name}.workflow.json`, await readFile(new URL(`src/workflows/${name}.workflow.json`, import.meta.url)));
  }
  const index = neuroflowRegistryIndex(files.keys(), {
    title: "Neurodesk webapps",
    description: "NeuroFlow tools for the Neurodesk webapp catalog.",
  });
  files.set("neuroflow-registry.json", Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  return files;
}

function neuroflowCatalog() {
  let files;
  const load = () => (files ??= catalogFiles());
  return {
    name: "neurodesk-neuroflow-catalog",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = /\/neuroflow\/([^?]+)/.exec(req.url ?? "")?.[1];
        const bytes = name && (await load()).get(decodeURIComponent(name));
        if (!bytes) return next();
        res.setHeader("Content-Type", name.endsWith(".mjs") ? "text/javascript" : "application/json");
        res.end(bytes);
      });
    },
    async generateBundle() {
      for (const [name, source] of await load()) this.emitFile({ type: "asset", fileName: `neuroflow/${name}`, source });
    },
  };
}

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "pipeline-builder",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  plugins: [neuroflowCatalog()],
});
