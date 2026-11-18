# Catalogue sites

The apps are served from several hosts. Each host serves one catalogue. Each app
has one home catalogue and can also be served by others.

| Host | Catalogue | Hosting | Apps |
| --- | --- | --- | --- |
| `webapps.neurodesk.org` | `neuro` | GitHub Pages | every app whose home is not listed below; a copy of Histology to MRI |
| `mskapps.sciget.org` | `msk` | Cloudflare Worker, assets only | MuscleMap, SeedSeg, Carotid Flow; copies of dcm2niix, DICOM View, dicompare, MRI2vid, niimath, ANTs Denoise and elastix |
| `microscopyapps.sciget.org` | `microscopy` | Cloudflare Worker, assets only | StarDist, micro-sam, Calcium imaging, Spot detection, Histology to MRI, Microscope QC, Deconvolution, NeuroMorph, OME-Zarr Converter, Stitching, Structure Tensor, Light-sheet atlas, ZARRo, Cryo-EM; copies of elastix, niimath and MRI2vid |
| `preclinicalapps.sciget.org` | `preclinical` | Cloudflare Worker, assets only | copies only: dcm2niix, DICOM View, dicompare, MRI2vid, niimath, Degibbs, ANTs Denoise, dwidenoise, elastix, QSMbly, ZARRo, Stitching, Structure Tensor, Calcium imaging, NeuroMorph |
| `webapps.sciget.org` | hub | Cloudflare Worker, assets only | none: one card per catalogue |

`neurodesk.org` DNS is on AWS Route 53, so the neuro catalogue stays on GitHub
Pages. `sciget.org` DNS is on Cloudflare.

## Registry

`registry/apps.yml` holds the hosts:

- `site.catalogs`: one entry per catalogue, with its `id`, `host`, `hosting`
  (`pages` or `worker`), `title`, `heading`, `description`, `brand` (product
  name, logo and icon files in `site/`, `theme`, home URL and the More Apps label) and `desktop`
  (its offline suite: see [Desktop suites](#desktop-suites)).
- `brand.theme` picks the look of the catalogue's landing page and of every app
  page it serves: `neurodesk` (Inter, neutral greys, the logo green) or `sciget`,
  which follows sciget.org (its greys, its orange accent, the system font stack
  and its wordmark). A `sciget` page carries `<html data-neurodesk-brand="sciget">`
  and `site/app-theme.css` and `site/landing.css` restate their tokens under it; a
  Neurodesk page carries no attribute. The hub takes `site.hub.brand.theme`.
- `brand.icon` is the browser-tab icon of the landing page and every app page;
  `brand.logo` is the header image. SciGet's icon is sciget.org's network graph,
  because its wordmark is unreadable at favicon size.
- `site.hub`: the hub page's host, text and brand.
- `catalog:` on every app: its home catalogue. Its old links redirect there, and
  other hosts' 404 pages send its path there.
- `also_in:` on an app, optional: other catalogues that serve a copy. Each copy
  carries the brand, title and URL of the host that serves it, and appears in that
  host's landing page and DICOM View menu. Analytics counts every copy.
- `former_paths:` on an app: paths it was served from before a rename.

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

- `dist/`: every app, as before. Each catalogue's desktop suite is projected
  from it (`scripts/desktop/assemble.mjs`).
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
  a catalogue's desktop suite is projected the same way and keeps it.
  Each page's `rel=canonical` names the app's home URL, so a copy points search
  engines at its home; `og:url` stays the host's own URL, so a shared link opens
  where it was shared from;
- the shared root files the app pages load (`app-shell.js`, `theme.js`, fonts,
  logos, `shell-adapters/`);
- the `_runtime/` families its files reference. A family is the directory two
  levels below `_runtime/` and is copied whole. References are followed between
  families. A `_runtime/` mention that is not a plain string path fails the build;
- its landing page, `standalone.json` entries, `_headers` and `404.html`;
- its usage report, `analytics.json`: its apps' rows from the report
  `scripts/write-analytics.mjs` writes at deploy, with the totals and countries
  that report records for the catalogue (visitors do not add up across apps).
  The landing page header links to the hub. The
  landing page embeds the apps it does not serve (`#elsewhere-apps`); a search
  that finds nothing here lists the matching ones, linking to their home hosts.
  The all-app `dist/` page and the desktop suite's offline page leave it out.

`test/catalog-sites.test.mjs` checks the built sites. Each site holds exactly its
catalogue's apps and exactly the runtime families its files reach. Every
reference that resolves in `dist/` also resolves in the site. Every handoff menu
lists only same-host apps. `pnpm audit:artifacts` audits `dist/` and each site,
and applies the 750 MiB Pages budget to the `pages` site only. Undeclared
duplicate content may be at most 10 % of a site. The audit prints the groups of
identical files that cost the most as `largestDuplicateGroups`. To lower the
share, move a group to a `deduplicate` family in `runtime-assets/manifest.json`,
which needs every reference to the file to be a plain string path.

A family matched by content (`match_by: "sha256"`) lists the apps that share it
under `consumers`. Assembly fails, naming the app and the family, when a listed
app ships other bytes or an unlisted app ships the family's bytes. An app that
moves to another build therefore needs that build registered as a family. A
shared WebAssembly family with `consumers` is also started in a browser:
`pnpm test:runtime-startup` instantiates each consumer's built module and
requires that it fetched the binary from the family's `_runtime/` path. The
target path carries the version, or a hash prefix when the build has none, so
new bytes never replace a URL that a cached worker still requests.

A file that fewer apps load than its family lists its own `consumers`. An app
keeps a file that one of its `app_scoped_runtime_families` pins, even when a
shared family holds the same bytes.

MindGrab's binaries are shared per release (`mindgrab-wasm-<date>`, under
`_runtime/mindgrab/<version>/`). Each app keeps the model modules
(`brainchop-<model>.js`): MindGrab imports them from `assetPath`, a computed
path, and the threaded CPU module starts its pthread workers from its own URL.
Only the binary each module names in a static `new URL` moves. For each app
that shares a threaded CPU binary, `pnpm test:runtime-startup` also segments a
head phantom on the CPU backend through the app's staged module, once per app
and at least once per binary (`SHARED_BINARY_EVERY_SEGMENTATION=1` runs every
pair). The WebGPU and WebGL2 binaries are instantiated there but not run:
hosted runners have neither backend.

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

`.github/workflows/deploy-pages.yml` runs on every push to `main`, daily at
04:17 UTC and on dispatch. It builds once, then:

- decides which sites to publish (`scripts/plan-site-deploy.mjs`,
  `scripts/lib/site-deploy.mjs`), writes the decision and its reason for each
  site to the job summary, and writes `site-digest.json` into each site;
- uploads `dist-sites/neuro` to GitHub Pages;
- deploys `dist-sites/msk`, `dist-sites/microscopy`, `dist-sites/preclinical` and `dist-sites/hub` with
  `wrangler deploy --config dist-sites/<site>.wrangler.json`, using the
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets;
- runs the deployed checks (`pnpm test:deployed`,
  `test/standalone-downloads.smoke.mjs`, `pnpm test:image-uploads`) once per
  catalogue host, with `SITE_CATALOG=<catalogue>` limiting them to that host's
  apps, and checks that the hub links every catalogue (`verify-hub`).

The deploy steps run only for the sites the run publishes. A site's content
digest is SHA-256 over its files' relative paths and bytes, plus its Wrangler
configuration, leaving out the root `analytics.json` and `site-digest.json`.
`site-digest.json` records the digest, the usage report's `generatedAt` (an ISO
instant or null) and the commit (40 hex digits, or null outside Actions). A site
is published when:

- the run was dispatched, by hand or by `standalone-catalog.yml` (every site);
- the run is a re-run (`GITHUB_RUN_ATTEMPT` above 1; every site). A re-run
  keeps its run id, so it reads no history. "Re-run failed jobs" re-runs only
  the jobs that failed and those that need them; the others, the build and its
  plan included, keep their results and outputs from the attempt before. So a
  re-run of a failed check checks the same sites, and a re-run build publishes
  everything;
- the deploy run before this one did not finish green (failed, cancelled
  part-way or timed out), or the plan cannot be certain of it (every site). The
  plan reads every run of this workflow created in the last 33 days, on every
  ref, since all of them share the concurrency group and any of them can
  publish. The run whose latest attempt started last (`run_started_at`, which
  a re-run moves) decides, among those that started a job: a run cancelled
  while it waited started none, so the run before it decides. GitHub re-runs a
  run only up to 30 days after it, so that history is certain of a deciding run
  that started in the last two days, and the daily schedule keeps one there.
  An earlier run still queued or in progress, two runs that started at the same
  instant, a re-run that started no job, a malformed field, a history that
  changed while it was read or holds more than 2000 runs, an API error or a
  timeout each publish every site. A live digest proves the bytes are live, not
  that their deploy and checks passed, so a failed Worker deploy, a sibling
  whose checks it skipped, or a failed browser check is retried by the next run;
- its host does not serve a readable record of this site. Only a direct `200`
  answer with an `application/json` type and no `Age` above 0 counts: a
  redirect is not followed, and the request asks every cache to revalidate. A
  record with a field of the wrong type, or a date that does not exist (such as
  31 February), is unreadable too;
- its digest differs from the served one;
- its served usage report predates the last 04:17 UTC refresh. The daily
  schedule exists for this: each catalogue's report is refreshed once a day,
  by the first run after that time. The hub has no report.

A site whose plan fails for any other reason is published. The job summary
names each decision and, for a forced publish, the run that forced it.

One deadline covers each whole exchange, headers and body: 30 seconds for each
live record and 120 seconds for the whole history read. The plan reads the
history while it digests the sites, so it writes its outputs within about two
minutes whatever the network does; a read that runs out of time publishes. The
plan step's 10 minute limit is a backstop.

`pnpm test:runtime-startup` runs before a deploy only when some site's content
may be new (every reason but the usage report). Content the hosts already serve
passed it when it was published. The deployed checks run for every site a run
publishes, and the daily run checks every live site, published or not: those
checks read the public hosts and the checked-out registry, not the build. So a
broken live site, or a change to the check scripts, is found within a day even
when no site changes and GA4 is unavailable.

Two builds of one commit differ only in `analytics.json`. `calmar/build-info.json`
names the commit of calmar's last uncached build and stays in the digest, so a
cold turbo cache republishes the neuro site.

The Cloudflare API token needs Workers Scripts edit on the account, plus
Workers Routes and DNS edit on the `sciget.org` zone. Wrangler needs these to
attach the custom domains.

## Adding a catalogue

1. Add an entry to `site.catalogs` with `hosting: worker`, and add its logo and
   icon to `site/` (and to `sharedSiteAssets` in `scripts/build-site.mjs`) if it
   has a new brand.
2. Set `catalog:` on its apps.
3. Add its site to the `worker-sites` artifact and the hub check in `deploy-pages.yml` (`test/catalog-site-projection.test.mjs` holds both to the registry). The `deploy-workers` and `verify-sites` matrices come from the registry through the deploy plan. The Pages deploy waits for `deploy-workers`, so the neuro 404 page never redirects to a host that is not live yet.
4. Build, then run `node --test test/catalog-sites.test.mjs` and
   `pnpm audit:artifacts`.
