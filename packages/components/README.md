# Neurodesk Webapp Components

Reusable, framework-free ESM components for static, privacy-preserving neuroimaging webapps.

This package extracts the shared architecture from:

- `neurodesk/lesion-network-mapping-webapp`
- `neurodesk/spinalcordtoolbox-webapp`
- `neurodesk/vesselboost-webapp`
- `neurodesk/musclemap-webapp`
- `astewartau/qsmbly`

The library is intentionally static-host friendly. It does not require React, a bundler, or a backend. Consumers can import individual modules from `src/` directly or through package exports.

## Architecture

Two app tracks are supported:

- Browser segmentation apps: upload NIfTI/DICOM, view in NiiVue, run ONNX inference in a worker, emit stage NIfTI outputs, download results.
- Browser algorithm pipelines: bucketed multi-input workflows, Rust/WASM or ONNX workers, mask preparation/editing, parameter-heavy settings, command preview, and validation reports.

See [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/components/catalog.md](docs/components/catalog.md).

The look of every app comes from one stylesheet, `src/styles/imaging-workspace.css`, and the light-DOM custom elements in `src/elements` and native dialog builder in `src/ui`. The monorepo's `docs/architecture/design-system.md` explains the vocabulary and the test that enforces it.

## Quick Start

```js
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core';
import { PipelineExecutor } from '@neurodesk/webapp-components/inference';
import { ViewerController } from '@neurodesk/webapp-components/viewer';

mountImagingWorkspace({
  root: document.body,
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'My Neurodesk App'
});

const viewer = new ViewerController({ nv });
const pipeline = new PipelineExecutor({ workerUrl: './inference-worker.js' });
```

The package provides the shared workspace, worker protocol, executor, viewer,
volume operations, NIfTI I/O, and UI bindings. Scientific task definitions and
model defaults remain app-owned.

## Verified downloads

`fetchModel` from `@neurodesk/webapp-components/worker` downloads model and example bytes,
checks their declared size and SHA-256, and reuses verified downloads across apps on the
same origin. `nd-example-selector` uses the same downloader with `retries: 4`, so its
HTTP 429 retries continue. A download whose headers or next body chunk do not arrive
within `stallTimeout` (30 s, `STALL_TIMEOUT` in `net/stallGuard.js`) fails with a
`TimeoutError`: the window is one of inactivity, not a total deadline, so a large model
still has minutes to arrive. The waits between retries are not counted.

```js
const bytes = await fetchModel({
  url: model.url,
  integrity: { bytes: model.bytes, sha256: model.sha256 },
}, { signal, onProgress });
```

When `cache` is omitted, assets with a 64-character SHA-256 pin use Cache Storage
`neurodesk-verified-assets-v1`. The key is the absolute same-origin URL
`/__neurodesk_cache__/sha256/<lowercase sha256>`, independent of the download URL,
app path, release version, and `asset.cacheKey`. Every cache hit is verified again.
Invalid entries are removed and downloaded again. Failed, partial, or cancelled
downloads are never published.

Set `cache: null` to opt out. Unpinned downloads do not use the automatic cache.
Explicit Cache Storage names and get/set adapters keep their supplied URL or
`asset.cacheKey` identity and their existing read/delete error behavior.
Automatic storage failures fall back to verified network downloads. Opening and
writing explicit Cache Storage also remain optional. `onCacheError(error)` reports
optional storage failures, or the downloader logs a warning when no hook is supplied.

On a window, the downloader requests persistent browser storage once per page when
it caches or reuses a verified asset. Workers leave that request to the page.
Persistence is best effort. Browsers can deny the request, evict cached bytes, or
clear them when users clear site data. Existing app caches and user data are retained.

## Development

```bash
pnpm install
pnpm --filter @neurodesk/webapp-components test
pnpm --filter @neurodesk/webapp-components check
pnpm --filter @neurodesk/webapp-components build:showcase
pnpm --filter @neurodesk/webapp-components serve
```

The showcase app runs at `http://127.0.0.1:8080/` by default and demonstrates the workspace, file triage, viewer controls, stage results, QSM command preview, echo navigation, and validation report rendering.

## Release And Staging

This workspace is versioned, tested, and released by the monorepo root workflows.
The showcase is a contract test and demonstration surface, not a separate Pages
deployment.

See [Custom elements](docs/components/elements.md) for registration, events, lifecycle, and migration from the former builders.
