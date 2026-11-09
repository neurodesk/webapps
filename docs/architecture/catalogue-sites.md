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
  (`pages` or `worker`), `title`, `heading`, `description` and `brand` (product
  name, logo file in `site/`, home URL and the More Apps label).
- `site.hub`: the hub page's host, text and brand.
- `catalog:` on every app: its home catalogue. Its old links redirect there, and
  other hosts' 404 pages send its path there.
- `also_in:` on an app, optional: other catalogues that serve a copy. Each copy
  carries the brand, title and URL of the host that serves it, and appears in that
  host's landing page and DICOM View menu. Analytics counts every copy.
- `former_paths:` on an app: paths it was served from before a rename.
- `desktop:` on every catalogue: its desktop suite's Electron `app_id` and
  `executable` (see [Desktop suites](#desktop-suites)).

Every catalogue host sends to one GA4 stream; the hub sends nothing. The
stream's cross-domain and unwanted-referral lists match `sciget.org` and
`webapps.neurodesk.org` by "contains" (the hub is covered only so that its
links are not counted as referrals), so a new
`*.sciget.org` catalogue needs no GA4 change. A host outside both needs a new
condition in GA4's tag settings; `test/analytics-contract.test.mjs` fails until
it is added there and to `GA4_DOMAIN_CONDITIONS`.

`scripts/lib/apps-registry.mjs` rejects an unknown, missing or repeated
`catalog`, a duplicate catalogue id or host, a catalogue without apps, and any
setup other than exactly one `pages` catalogue on `site.domain`. `also_in` must name other
declared catalogues, each once. To move an app, change its `catalog:`; to serve
it on another host too, add that catalogue to `also_in`.

## Build

`pnpm build` builds each app once, then `scripts/build-site.mjs` writes:

- `dist/`: every app, as before. The full desktop suite assembles from it
  (`scripts/desktop/assemble.mjs`), so its DICOM View still hands off to every app.
  Each other catalogue's suite assembles from its `dist-sites/<catalogue>/`.
- `dist-sites/<catalogue>/`: one deployable site per catalogue
  (`scripts/lib/catalog-sites.mjs`).
- `dist-sites/hub/`: the hub page (`scripts/lib/hub-page.mjs`).
- `dist-sites/<site>.wrangler.json`: the Worker configuration of each
  Worker-hosted site, generated from the registry.

A catalogue site holds:

- its apps, themed again with the catalogue's brand and a handoff list of the
  apps on that host. Each app page names its catalogue in
  `<html data-neurodesk-catalog="<id>">`, so an app can open with defaults for
  that audience (ZARRo opens on an OME-Zarr URL on `microscopy`). The all-app
  assembly in `dist/`, standalone builds and the dev server carry no attribute;
  the desktop suite is built from `dist/`;
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
Flow; the copy of DICOM View on `mskapps.sciget.org` does. The full Neurodesk suite
keeps every handoff.

## Desktop suites

Each catalogue has its own offline desktop suite. `desktopSuite` in
`scripts/lib/standalone.mjs` derives it from the registry, and
`scripts/desktop/suites.mjs` selects one for the desktop scripts (`--catalog <id>`,
else `NEURODESK_SUITE`, else the full suite).

- The primary catalogue's suite is the full suite. It holds every app and
  assembles from `dist/`, so its DICOM View keeps every handoff.
- Every other catalogue's suite is an edition. It holds that catalogue's apps and
  assembles from `dist-sites/<catalogue>/`: the catalogue's brand, handoffs to the
  same apps only, and the runtime families they reach. Its offline start page
  carries the catalogue's title and logo.
- The suite is named after the catalogue's `title` (for example Microscopy
  Webapps). Its Electron appId and executable come from the catalogue's `desktop:`
  block, such as `microscopy-webapps`.
- The full suite releases as `webapps-vVERSION`, an edition as
  `webapps-<catalogue>-vVERSION`. All suites share the desktop version. Only the
  full suite ships the Apptainer SIF and runs the offline workflow, container and
  model-pack tests.
- `registry/standalone.json` records the full suite under `suite` and an edition
  under `suites.<catalogue>`. A catalogue's landing page and its site's
  `standalone.json` link its own edition once it is recorded, and the full suite
  before that (`linkedSuite`).

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
4. Give it a `desktop:` block (`app_id`, `executable`). In
   `.github/workflows/standalone.yml`, add it to the desktop job's `suite` matrix
   and add the bundle job's two upload steps, `offline-resources-<id>` and
   `desktop-<id>-models-pack`. `test/independent-workflows.test.mjs` holds the
   workflow to the registry's suites.
5. Build, then run `node --test test/catalog-sites.test.mjs` and
   `pnpm audit:artifacts`.
