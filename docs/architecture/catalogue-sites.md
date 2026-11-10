# Catalogue sites

The apps are served from several hosts. Each host serves one catalogue. Each app
has one home catalogue and can also be served by others.

| Host | Catalogue | Hosting | Apps |
| --- | --- | --- | --- |
| `webapps.neurodesk.org` | `neuro` | GitHub Pages | every app whose home is not listed below |
| `mskapps.sciget.org` | `msk` | Cloudflare Worker, assets only | MuscleMap, SeedSeg, Carotid Flow; copies of dcm2niix, DICOM View, dicompare, MRI2vid, niimath, ANTs Denoise and elastix |
| `microscopyapps.sciget.org` | `microscopy` | Cloudflare Worker, assets only | StarDist, micro-sam, Calcium imaging, Spot detection, Microscope QC, NeuroMorph, Stitching, Structure Tensor, ZARRo, Cryo-EM; copies of elastix, niimath and MRI2vid |
| `preclinicalapps.sciget.org` | `preclinical` | Cloudflare Worker, assets only | copies only: dcm2niix, DICOM View, dicompare, MRI2vid, niimath, Degibbs, ANTs Denoise, dwidenoise, elastix, QSMbly, ZARRo, Stitching, Structure Tensor, Calcium imaging, NeuroMorph |
| `webapps.sciget.org` | hub | Cloudflare Worker, assets only | none: one card per catalogue |

`neurodesk.org` DNS is on AWS Route 53, so the neuro catalogue stays on GitHub
Pages. `sciget.org` DNS is on Cloudflare.

## Registry

`registry/apps.yml` holds the hosts:

- `site.catalogs`: one entry per catalogue, with its `id`, `host`, `hosting`
  (`pages` or `worker`), `title`, `heading`, `description`, `brand` (product
  name, logo file in `site/`, home URL and the More Apps label) and `desktop`
  (its offline suite: see [Desktop suites](#desktop-suites)).
- `site.hub`: the hub page's host, text and brand.
- `catalog:` on every app: its home catalogue. Its old links redirect there, and
  other hosts' 404 pages send its path there.
- `also_in:` on an app, optional: other catalogues that serve a copy. Each copy
  carries the brand, title and URL of the host that serves it, and appears in that
  host's landing page and DICOM View menu. Analytics counts every copy.
- `former_paths:` on an app: paths it was served from before a rename.

`scripts/lib/apps-registry.mjs` rejects an unknown, missing or repeated
`catalog`, a duplicate catalogue id or host, a catalogue without apps, and any
setup other than exactly one `pages` catalogue on `site.domain`. `also_in` must name other
declared catalogues, each once. To move an app, change its `catalog:`; to serve
it on another host too, add that catalogue to `also_in`.

## Build

`pnpm build` builds each app once, then `scripts/build-site.mjs` writes:

- `dist/`: every app, as before. Each catalogue's desktop suite is projected
  from it (`scripts/desktop/assemble.mjs`).
- `dist-sites/<catalogue>/`: one deployable site per catalogue
  (`scripts/lib/catalog-sites.mjs`).
- `dist-sites/hub/`: the hub page (`scripts/lib/hub-page.mjs`).
- `dist-sites/<site>.wrangler.json`: the Worker configuration of each
  Worker-hosted site, generated from the registry.

A catalogue site holds:

- its apps, themed again with the catalogue's brand and a handoff list of the
  apps on that host;
- the shared root files the app pages load (`app-shell.js`, `theme.js`, fonts,
  logos, `shell-adapters/`);
- the `_runtime/` families its files reference. A family is the directory two
  levels below `_runtime/` and is copied whole. References are followed between
  families. A `_runtime/` mention that is not a plain string path fails the build;
- its landing page, `standalone.json` entries, `_headers` and `404.html`.

`test/catalog-sites.test.mjs` checks the built sites. Each site holds exactly its
catalogue's apps and exactly the runtime families its files reach. Every
reference that resolves in `dist/` also resolves in the site. Every handoff menu
lists only same-host apps. `pnpm audit:artifacts` audits `dist/` and each site,
and applies the 750 MiB Pages budget to the `pages` site only.

## Shared tools

General tools keep their home and are copied, through `also_in`, to the
catalogues where they apply without change: conversion, viewing, protocol
checks, image maths, denoising and elastix registration. A copy needs no anatomy
model, template or mask it would infer itself. These are not copied, or not to
the catalogue named:

- N4, which extracts a brain with MindGrab when no mask is given and fixes its
  B-spline spacing at 100 mm;
- Greedy and ANTs, which expect brain-extracted images and offer MNI templates
  (elastix covers registration for every anatomy);
- Degibbs on msk, whose diffusion category would add a diffusion section there.

Microscopy gets niimath and MRI2vid for volumes already in NIfTI, such as the maps
Structure Tensor and Spot detection write; of the general tools only elastix reads
TIFF and OME-Zarr. The preclinical catalogue keeps QSMbly for
its rodent masks (RS2-Net and voxel-scaled BET) and the tissue and rodent
neuroscience microscopy tools; general cell-biology tools stay on microscopy.

## Moved apps

`site/404.html` is a template. `scripts/lib/not-found-page.mjs` renders it per
host with a table from the registry:

- a former path redirects to its app;
- an app of another catalogue redirects to that catalogue's host.

The redirect keeps the rest of the path, the query and the fragment, so
`https://webapps.neurodesk.org/musclemap/?x=1#y` reaches
`https://mskapps.sciget.org/musclemap/?x=1#y`. GitHub Pages and the Worker
(`not_found_handling: 404-page`) both serve `404.html` for a missing path. A
returning visitor's isolation service worker fetches navigations from the
network (`coi-serviceworker.js`), so the 404 page runs. dicompare's route bridge
loads only on the host that serves dicompare.

The legacy domains `musclemap.neurodesk.org` and `seedseg.neurodesk.org` redirect
to `https://webapps.neurodesk.org/<app>/` (checked 2026-11-05). That page is
missing on the neuro host, so the 404 table sends the visitor on to
`mskapps.sciget.org`. The redirect repositories do not need a change.

## Accepted regression

A handoff opens the receiving app on the same origin. DICOM View on
`webapps.neurodesk.org` therefore no longer offers MuscleMap, SeedSeg or Carotid
Flow; the copy of DICOM View on `mskapps.sciget.org` does. The desktop suites
follow the same rule: each lists only its own apps.

## Desktop suites

Each catalogue ships its own offline Electron suite, holding the apps its host
serves. `desktop` in its `site.catalogs` entry names it:

| Key | Use | neuro | msk |
| --- | --- | --- | --- |
| `product_name` | window, archive notes, release title | Neurodesk Webapps | MSK Webapps |
| `app_id` | macOS bundle id and Windows app id | `org.neurodesk.webapps` | `org.sciget.msk` |
| `release` | GitHub tag `<release>-v<version>` and archive prefix | `webapps` | `msk-webapps` |
| `executable` | `.app`, `.exe` and Linux binary name | `neurodesk-webapps` | `msk-webapps` |

Each value is unique, so suites install side by side, and `release` is never an
app id. The neuro values are those of the suite released before catalogues had
their own, so existing installations keep updating.

`scripts/desktop/assemble.mjs --catalog <id>` (the primary catalogue by default)
projects the catalogue site from `dist/` with `projectCatalogSite`, drops the
host-only `404.html`, `_headers` and `.nojekyll`, and copies the offline assets
of those apps only. Its DICOM View therefore hands off only to apps of that suite,
and its model pack holds only their models. The bundle manifest records the
catalogue, and `pack.mjs`, `models-pack.mjs` and `container.mjs` read it from
there; `publish.mjs` takes `--catalog`. The Apptainer SIF is built for the
primary catalogue only.

`registry/standalone.json` lists each published suite under `suites`, keyed by
catalogue id. A catalogue without an entry has not published a suite yet, and its
landing page shows no download link. The `standalone` workflow builds once, then
assembles, tests and publishes one suite per catalogue. A suite runs the offline
workflows of the apps it is home to; a copy's workflow runs in its home suite.
Its model pack is tested with every app it serves that reads a model.

## Deployment

`.github/workflows/deploy-pages.yml` builds once, then:

- uploads `dist-sites/neuro` to GitHub Pages;
- deploys `dist-sites/msk`, `dist-sites/microscopy`, `dist-sites/preclinical` and `dist-sites/hub` with
  `wrangler deploy --config dist-sites/<site>.wrangler.json`, using the
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets;
- runs the deployed checks (`pnpm test:deployed`,
  `test/standalone-downloads.smoke.mjs`, `pnpm test:image-uploads`) once per host,
  with `SITE_CATALOG=<catalogue>` limiting them to that host's apps.

The Cloudflare API token needs Workers Scripts edit on the account, plus
Workers Routes and DNS edit on the `sciget.org` zone. Wrangler needs these to
attach the custom domains.

## Adding a catalogue

1. Add an entry to `site.catalogs` with `hosting: worker`, and add its logo to
   `site/` if it has a new brand.
2. Set `catalog:` on its apps.
3. Add its site to the `worker-sites` artifact, the `deploy-workers` and `verify-workers` matrices and the hub check in `deploy-pages.yml` (`test/catalog-site-projection.test.mjs` holds all four to the registry). The Pages deploy waits for `deploy-workers`, so the neuro 404 page never redirects to a host that is not live yet.
4. Build, then run `node --test test/catalog-sites.test.mjs` and
   `pnpm audit:artifacts`.
