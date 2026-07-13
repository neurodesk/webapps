const ATLAS_CACHE = 'lnm-assets-v1';

async function getNifti() {
  if (globalThis.nifti) return globalThis.nifti;
  // The bundled nifti-reader-js file is UMD; loading it installs globalThis.nifti.
  await import('../nifti-js/index.js');
  if (!globalThis.nifti) {
    throw new Error('NIfTI parser is not available');
  }
  return globalThis.nifti;
}

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function typedArrayForImage(header, imageBuffer) {
  const byteOffset = imageBuffer.byteOffset || 0;
  switch (header.datatypeCode) {
    case 2:
      return new Uint8Array(imageBuffer, byteOffset);
    case 4:
      return new Int16Array(imageBuffer, byteOffset);
    case 8:
      return new Int32Array(imageBuffer, byteOffset);
    case 16:
      return new Float32Array(imageBuffer, byteOffset);
    case 64:
      return new Float64Array(imageBuffer, byteOffset);
    case 256:
      return new Int8Array(imageBuffer, byteOffset);
    case 512:
      return new Uint16Array(imageBuffer, byteOffset);
    case 768:
      return new Uint32Array(imageBuffer, byteOffset);
    default:
      throw new Error(`Unsupported NIfTI datatype: ${header.datatypeCode}`);
  }
}

function extractDims(header) {
  const dimCount = Number(header.dims?.[0]);
  if (dimCount === 3 || (dimCount === 4 && Number(header.dims[4]) === 1)) {
    return [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])];
  }
  throw new Error(`Unsupported NIfTI dimensions: ${header.dims?.join('x')}`);
}

function dimsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index]);
}

export async function decodeNiftiBuffer(arrayBuffer) {
  const niftiApi = await getNifti();
  let buffer = toArrayBuffer(arrayBuffer);
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    buffer = niftiApi.decompress(buffer);
  }
  if (!niftiApi.isNIFTI(buffer)) {
    throw new Error('Input is not a NIfTI file');
  }

  const header = niftiApi.readHeader(buffer);
  const imageBuffer = niftiApi.readImage(header, buffer);
  const data = typedArrayForImage(header, imageBuffer);
  const dims = extractDims(header);
  const dtype = header.getDatatypeCodeString
    ? header.getDatatypeCodeString(header.datatypeCode)
    : String(header.datatypeCode);

  return { data, dims, dtype, header };
}

async function loadManifest() {
  if (typeof fetch === 'undefined') {
    throw new Error('fetch is required to load atlas manifest');
  }
  const response = await fetch('./models/manifest.json');
  if (!response.ok) {
    throw new Error(`Failed to load manifest: HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchAtlasBuffer(manifestEntry) {
  if (typeof fetch === 'undefined') {
    throw new Error('fetch is required to load atlas asset');
  }
  let cache = null;
  if (typeof caches !== 'undefined') cache = await caches.open(ATLAS_CACHE);
  return fetchCacheFirst(manifestEntry.sourceUrl, manifestEntry.cacheKey, cache);
}

async function loadConnectomeIndex(manifestEntry, cache) {
  const indexCacheKey = manifestEntry.cacheKey
    ? `${manifestEntry.cacheKey}:index`
    : null;
  const indexUrl = manifestEntry.indexSourceUrl;
  if (!indexUrl) {
    throw new Error(`Connectome ${manifestEntry.id} missing indexSourceUrl`);
  }
  const indexBuf = await fetchCacheFirst(indexUrl, indexCacheKey, cache);
  return JSON.parse(new TextDecoder('utf-8').decode(indexBuf));
}

// Phase 4: load a connectome pack (.bin + companion index.json) via the
// same Cache Storage path the atlas-loader uses for atlases. Returns the
// raw ArrayBuffer for the .bin plus the parsed index.
//
// Phase 37: optional `onProgress` callback fires during the .bin
// streaming download (the .bin is the heavy fetch — ~30 MB for the
// Yeo7 FC pack). Cache hits skip the callback.
export async function loadConnectomeFromManifest(connectomeAssetId, { manifest, onProgress } = {}) {
  const assetManifest = manifest || await loadManifest();
  const manifestEntry = assetManifest.connectomeAssets?.find(
    a => a.id === connectomeAssetId
  );
  if (!manifestEntry) {
    throw new Error(`Connectome asset not found: ${connectomeAssetId}`);
  }
  if (manifestEntry.supportStatus !== 'supported') {
    throw new Error(`Connectome asset is not supported: ${connectomeAssetId}`);
  }

  // Fetch + cache the .bin under the same lnm-assets-v1 cache used for atlases.
  let cache = null;
  if (typeof caches !== 'undefined') {
    cache = await caches.open(ATLAS_CACHE);
  }
  const arrayBuffer = await fetchCacheFirst(
    manifestEntry.sourceUrl,
    manifestEntry.cacheKey,
    cache,
    { onProgress, label: connectomeAssetId }
  );

  // The companion index.json is small (~hundreds of bytes); fetch and cache it
  // under cacheKey + ':index' so the byte-offsets round-trip too.
  const index = await loadConnectomeIndex(manifestEntry, cache);

  return { arrayBuffer, index, manifestEntry };
}

export async function loadConnectomeChannelsFromManifest(connectomeAssetId, channelIds, {
  manifest,
  onProgress
} = {}) {
  const assetManifest = manifest || await loadManifest();
  const manifestEntry = assetManifest.connectomeAssets?.find(
    a => a.id === connectomeAssetId
  );
  if (!manifestEntry) {
    throw new Error(`Connectome asset not found: ${connectomeAssetId}`);
  }
  if (manifestEntry.supportStatus !== 'supported') {
    throw new Error(`Connectome asset is not supported: ${connectomeAssetId}`);
  }

  let cache = null;
  if (typeof caches !== 'undefined') cache = await caches.open(ATLAS_CACHE);
  const index = await loadConnectomeIndex(manifestEntry, cache);

  const requested = new Set((channelIds || []).map(id => String(id)));
  if (!Array.isArray(index.shards) || index.shards.length === 0 || requested.size === 0) {
    return loadConnectomeFromManifest(connectomeAssetId, { manifest: assetManifest, onProgress });
  }

  const shards = [];
  for (const shard of index.shards) {
    const labels = (shard.channelLabels || []).map(id => String(id));
    const neededLabels = labels.filter(label => requested.has(label));
    if (neededLabels.length === 0) continue;
    const arrayBuffer = await fetchCacheFirst(
      shard.sourceUrl,
      shard.cacheKey || `${manifestEntry.cacheKey}:shard:${shard.id || shards.length}`,
      cache,
      { onProgress, label: shard.id || connectomeAssetId }
    );
    shards.push({ shard, arrayBuffer, neededLabels });
  }
  if (shards.length === 0) {
    throw new Error(`No connectome shards cover requested channels: ${Array.from(requested).join(',')}`);
  }
  return { index, manifestEntry, shards };
}

// Shared fetch+cache helper. Returns ArrayBuffer. Uses the URL itself as
// the cache key — Chromium's Cache Storage rejects bare strings that
// resemble URL schemes (e.g. 'yeo7-fc-pack-adhd200-n30-v1' parses as a
// scheme name and fails). The manifest's cacheKey is folded into the URL
// search-params so different versions of the same source URL don't collide.
//
// Exported for unit testing (Phase 33 audit) — production callers go
// through fetchAtlasBuffer / loadConnectomeFromManifest.
//
// Phase 37: optional onProgress({ received, total, label }) callback fires
// during streaming download. The atlases (Yeo7 ~70 KB) are too small to
// matter, but the FC pack (~30 MB) is worth surfacing — silently
// stalling for 10-30 s on a slow link without progress is a user-
// experience cliff. Cache hits skip the callback (instant).
export async function fetchCacheFirst(url, cacheKey, cache, options = {}) {
  const { onProgress, label } = options;
  const cacheUrl = cacheKey ? `${url}#${encodeURIComponent(cacheKey)}` : url;
  if (cache) {
    const hit = await cache.match(cacheUrl);
    if (hit) return hit.arrayBuffer();
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> HTTP ${response.status}`);

  // Stream-read for progress reporting if a callback is provided AND
  // the response body is a streamable ReadableStream (it is in browsers
  // and modern Node fetch). Fall back to the simple arrayBuffer path
  // when no callback or no streaming.
  let buf;
  if (onProgress && response.body && typeof response.body.tee === 'function') {
    const [progressStream, cacheStream] = response.body.tee();
    const total = parseInt(response.headers.get('content-length'), 10) || 0;
    const reader = progressStream.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      try { onProgress({ received, total, label: label || cacheKey || url }); }
      catch (e) { /* progress is best-effort */ }
    }
    buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    if (cache) {
      try {
        const cachedResponse = new Response(cacheStream, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText
        });
        await cache.put(cacheUrl, cachedResponse);
      } catch (e) { /* non-fatal */ }
    }
    return buf.buffer;
  }

  if (cache) {
    try {
      await cache.put(cacheUrl, response.clone());
    } catch (e) { /* non-fatal: continue without cache */ }
  }
  return response.arrayBuffer();
}

export async function loadAtlasFromManifest(atlasAssetId, { manifest } = {}) {
  const assetManifest = manifest || await loadManifest();
  const manifestEntry = assetManifest.atlasAssets?.find(asset => asset.id === atlasAssetId);
  if (!manifestEntry) {
    throw new Error(`Atlas asset not found: ${atlasAssetId}`);
  }
  if (manifestEntry.supportStatus !== 'supported') {
    throw new Error(`Atlas asset is not supported: ${atlasAssetId}`);
  }

  const arrayBuffer = await fetchAtlasBuffer(manifestEntry);
  const decoded = await decodeNiftiBuffer(arrayBuffer);
  if (!dimsEqual(decoded.dims, manifestEntry.dims)) {
    throw new Error(
      `Atlas dims ${decoded.dims.join('x')} do not match manifest ${manifestEntry.dims.join('x')}`
    );
  }

  return {
    data: decoded.data,
    dims: decoded.dims,
    // Phase 6.2: surface the NIfTI header so callers can grab the world
    // affine for affine-aware resampling onto the atlas grid.
    header: decoded.header,
    manifestEntry,
    networkLabels: manifestEntry.networkLabels,
    parcelLabels: manifestEntry.parcelLabels
  };
}
