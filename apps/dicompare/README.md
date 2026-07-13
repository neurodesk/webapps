# dicompare Web & Desktop App

This repository contains the **web and desktop application** for [dicompare](https://github.com/astewartau/dicompare-pip), an open-source tool for automated validation and comparison of MRI acquisition protocols using DICOM metadata.

The app provides a visual interface for building, viewing, and validating imaging protocol schemas — all running locally in the browser with no data uploads required.

dicompare is a collaboration between the [Neurodesk](https://www.neurodesk.org/) and [Brainlife](https://brainlife.io/) groups.

**Live app:** [dicompare.neurodesk.org](https://dicompare.neurodesk.org/) | [brainlife.io/dicompare](https://brainlife.io/dicompare)

<img width="1386" height="844" alt="image" src="https://github.com/user-attachments/assets/1fc347ab-4daa-43a8-ab16-6a6013f33dd3" />

---

## How It Works

This app is a frontend built on top of the [`dicompare`](https://github.com/astewartau/dicompare-pip) Python package, which runs in the browser via [Pyodide](https://pyodide.org/) (Python compiled to WebAssembly). All DICOM processing happens locally — no imaging data leaves your machine.

For the command-line interface (CLI) or Python API, see the [`dicompare` pip package](https://github.com/astewartau/dicompare-pip).

---

## Features

- **Workspace** — Load DICOM files, build protocol schemas from reference data, attach schemas from the built-in library, and validate test data against schemas with visual compliance reports
- **Schema Viewer** — Browse, inspect, and print protocol schemas from the built-in library or loaded from file/URL
- **Image Viewer** — View DICOM and NIfTI volumes with multiplanar display and side-by-side comparison
- **Print Reports** — Generate formatted compliance and protocol reports with configurable sections and embedded volume thumbnails
- **Schema Library** — Bundled protocol templates from HCP, ABCD, UK Biobank, PING, and domain-specific guidelines (QSM, ASL, MS/CMSC)
- **Privacy-First** — All processing is local; no data is uploaded to any server

---

## Desktop App

For offline use or better performance, download the desktop app from [GitHub Releases](https://github.com/astewartau/dicompare-web/releases):

- **Windows**: `.exe` installer or portable version
- **macOS**: `.dmg` disk image
- **Linux**: `.AppImage` or `.deb` package

The desktop app includes full offline support (no internet required after installation), PDF export for compliance reports, and all Python dependencies bundled via Pyodide.

---

## Embedding dicompare in your tool

dicompare provides reusable JavaScript modules for adding DICOM protocol validation to any browser-based tool. These are served from the deployed app and can be imported directly — no npm install or build step required.

### Quick start

```js
import { DicompareController } from 'https://dicompare.neurodesk.org/embed/DicompareController.js';
import { DicompareReportRenderer } from 'https://dicompare.neurodesk.org/embed/DicompareReportRenderer.js';

// 1. Create controller with your schema
const controller = new DicompareController({
  schemaUrl: 'https://dicompare.neurodesk.org/schemas/QSM_Consensus_Guidelines_v1.0.json',
  updateOutput: (msg) => console.log(msg)
});

// 2. Retain DICOM files (e.g. from a file input)
await controller.retainDicomFiles(fileInput.files);

// 2b. (Diffusion, optional) Retain gradient files so shell/direction
//     descriptors can be validated — a .dvs, or an FSL .bvec + .bval pair.
await controller.retainGradientFiles(gradientInput.files);

// 3. Run validation
const { acquisitions, complianceResults, schema } = await controller.runValidation((progress) => {
  console.log(`${progress.percentage}% — ${progress.currentOperation}`);
});

// 4. Render results
const renderer = new DicompareReportRenderer();
renderer.render(document.getElementById('report-container'), { acquisitions, complianceResults, schema });

// 5. (Optional) Generate printable HTML
const printHtml = renderer.generatePrintHtml({ acquisitions, complianceResults, schema });
const printWindow = window.open('', '_blank');
printWindow.document.write(printHtml);
```

### Embed files

All files are served from `https://dicompare.neurodesk.org/embed/`:

| File | Description |
|------|-------------|
| `DicompareController.js` | ES module. Manages Pyodide worker lifecycle, DICOM analysis, and schema validation. Optionally accepts diffusion gradient files (`.dvs` / FSL `.bvec`+`.bval`) via `retainGradientFiles()`, deriving shell/direction descriptors and attaching them to the acquisitions before validation. |
| `DicompareReportRenderer.js` | ES module. Renders compliance results into DOM elements and generates printable HTML reports. |
| `dicompare-worker.js` | Web Worker script. Runs Pyodide + dicompare Python package in a background thread. Loaded automatically by the controller via fetch + blob URL (no cross-origin issues). |
| `dicompare-embed.css` | Optional stylesheet for the report renderer. Uses CSS custom properties with fallback defaults — override `--color-primary`, `--color-border`, etc. to match your app's theme. |

### Available schemas

Schemas from the [dicompare schema library](https://dicompare.neurodesk.org) are served at `https://dicompare.neurodesk.org/schemas/`. See [`public/schemas/index.json`](public/schemas/index.json) for the full list. Examples:

- `https://dicompare.neurodesk.org/schemas/QSM_Consensus_Guidelines_v1.0.json`
- `https://dicompare.neurodesk.org/schemas/SeedSeg_Prostate_T1w_v1.0.json`
- `https://dicompare.neurodesk.org/schemas/hcp_schema.json`

### CSS theming

The embed CSS uses CSS custom properties. Define these in your app to match your theme:

```css
:root {
  --color-primary: #2563eb;
  --color-border: #e5e7eb;
  --color-text: #1a1a1a;
  --color-text-muted: #6b7280;
  --color-text-dim: #9ca3af;
  --color-surface: #f9fafb;
  --color-surface-elevated: #f3f4f6;
  --color-success: #16a34a;
  --color-success-bg: #dff0d8;
  --color-error: #dc2626;
  --color-error-bg: #f2dede;
  --color-warning: #ca8a04;
  --color-warning-bg: #fcf8e3;
}
```

If you don't define these, sensible defaults are used.

### Examples

Tools using dicompare embed:

- [SeedSeg](https://seedseg.neurodesk.org) — Prostate fiducial marker segmentation (validates against SeedSeg T1w protocol)
- [qsmbly](https://qsmbly.neurodesk.org) — Quantitative susceptibility mapping (validates against QSM consensus guidelines)

---

## Schema DOIs (Zenodo)

Each library schema can be assigned a citable [Zenodo](https://zenodo.org/) DOI. The DOI
record hosts the schema's JSON file and links back to its dicompare page
(e.g. `https://dicompare.neurodesk.org/schema/MS_CMSC_Guidelines_v1.0`). When a DOI exists,
the schema viewer shows it with a **Copy DOI** button and a "Cite this schema" entry in the
citation dialog.

### How it works

- **`.github/scripts/publish-zenodo.py`** — stdlib-only Python script that walks
  [`public/schemas/index.json`](public/schemas/index.json), checksums each schema, and
  creates a Zenodo deposition (or a *new version* of an existing record when the content
  changed, preserving a stable **concept DOI**). It writes the results to a mapping file
  (`--mapping`), keyed by schema slug.
- **`.github/workflows/publish-dois.yml`** — runs on the same cadence as the deploy: when a
  release triggers the **Version Bump** workflow (automatic runs publish to **production**),
  or on demand via `workflow_dispatch` (default **sandbox**). It commits the updated mapping
  back to `main` and, for production runs, redeploys the site.
- **Two mapping files** keep sandbox and production records (whose IDs are incompatible)
  apart:
  - [`public/schemas/doi-mapping.json`](public/schemas/doi-mapping.json) — **production**,
    read by the site.
  - [`public/schemas/doi-mapping.sandbox.json`](public/schemas/doi-mapping.sandbox.json) —
    **sandbox**, testing only.
- **Frontend** reads the production `doi-mapping.json` at runtime
  ([`src/utils/schemaDoi.ts`](src/utils/schemaDoi.ts)) and displays the DOI in
  [`SchemaViewerPage`](src/pages/SchemaViewerPage.tsx). Schemas without a published DOI
  simply omit the DOI UI. (Sandbox DOIs are never shown — they don't resolve on `doi.org`.)

### Setup

1. Create a Zenodo account and a personal access token with the `deposit:write` and
   `deposit:actions` scopes. Use [sandbox.zenodo.org](https://sandbox.zenodo.org) for
   testing — its DOIs are not citable but the workflow is identical.
2. Add the token as a repository secret: `ZENODO_SANDBOX_TOKEN` (sandbox) and/or
   `ZENODO_TOKEN` (production).
3. Test against sandbox first via **Actions → Publish Schema DOIs → Run workflow → sandbox**.
   Production DOIs are then minted automatically on each new release, or on demand by running
   the workflow with the `production` target.

You can also dry-run locally without a token (defaults to the production mapping):

```bash
python3 .github/scripts/publish-zenodo.py --dry-run
# or preview against the sandbox mapping:
python3 .github/scripts/publish-zenodo.py --dry-run --mapping public/schemas/doi-mapping.sandbox.json
```

---

## Contributing

### Prerequisites

- Node.js 18+
- npm

### Web Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

### Electron Development

```bash
# Download Pyodide packages for offline use
npm run download:pyodide

# Start Electron in development mode
npm run dev:electron
```

### Building

```bash
# Build web app
npm run build

# Build desktop app (choose your platform)
npm run build:linux
npm run build:mac
npm run build:win
```

## Tech Stack

- React 19 + TypeScript
- Tailwind CSS
- Pyodide (Python in WebAssembly)
- Electron (desktop app)

## License

MIT License — see [LICENSE](LICENSE) for details.

## Links

- [dicompare Python Package](https://github.com/astewartau/dicompare-pip) — Core engine, CLI, and Python API
- [Live App (Neurodesk)](https://dicompare.neurodesk.org/)
- [Live App (Brainlife)](https://brainlife.io/dicompare)
- [Report Issues](https://github.com/astewartau/dicompare-web/issues)
