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
