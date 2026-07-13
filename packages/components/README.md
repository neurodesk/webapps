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

## Quick Start

```js
import { createNeuroWebapp } from '@neurodesk/webapp-components';
import { ConsoleOutput, ProgressManager } from '@neurodesk/webapp-components/ui';
import { FileIOController } from '@neurodesk/webapp-components/file-io';
import { PipelineExecutor } from '@neurodesk/webapp-components/inference';

const app = createNeuroWebapp({
  root: document.body,
  title: 'My Neurodesk App',
  subtitle: 'Browser inference',
  version: '0.1.0'
});

const consoleOutput = new ConsoleOutput({ element: app.refs.consoleOutput });
const progress = new ProgressManager({
  barElement: app.refs.progressBar,
  textElement: app.refs.statusText
});

const files = new FileIOController({
  mode: 'simple',
  updateOutput: message => consoleOutput.log(message)
});

const executor = new PipelineExecutor({
  workerUrl: './worker.js',
  updateOutput: message => consoleOutput.log(message),
  setProgress: (value, text) => progress.setProgress(value, text)
});
```

## Development

```bash
npm install
npm test
npm run check
npm run build:showcase
npm run serve
```

The showcase app runs at `http://127.0.0.1:8080/` by default and demonstrates the app shell, sidebar sections, file triage, viewer controls, stage results, plugin catalog, QSM command preview, echo navigation, and validation report rendering.

## Release And Staging

GitHub Actions are adapted from `neurodesk/lesion-network-mapping-webapp`:

- `.github/workflows/release.yml` is manual-only, validates the package, bumps the patch version, tags `vX.Y.Z`, and creates the GitHub release.
- `.github/workflows/deploy-pages.yml` deploys production from the latest release tag and `/staging/` from `main`.

The Pages artifact is the static showcase built by `npm run build:showcase`.
