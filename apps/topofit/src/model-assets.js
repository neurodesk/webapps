import manifest from '@neurodesk/topofit/manifest';
import { fetchModel } from '@neurodesk/webapp-components/worker';

export function createAssetLoader({ baseUrl, onProgress = () => {} }) {
  return async (name, from, to) => {
    const entry = manifest.assets.find((candidate) => candidate.filename === name);
    if (!entry) throw new Error(`TopoFit release is missing ${name}.`);
    return fetchModel(
      {
        url: `${baseUrl}${name}?sha256=${entry.sha256}`,
        integrity: { bytes: entry.bytes, sha256: entry.sha256 },
      },
      {
        onProgress: ({ fraction }) => onProgress(from + (to - from) * (fraction || 0), `Loading ${name}…`),
      },
    );
  };
}
