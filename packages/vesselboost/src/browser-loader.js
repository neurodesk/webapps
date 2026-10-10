import { fetchModel } from '@neurodesk/webapp-components/worker';
export function fetchVerifiedModel(asset, { url = asset.url, ...options } = {}) {
  return fetchModel({ url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, options);
}
