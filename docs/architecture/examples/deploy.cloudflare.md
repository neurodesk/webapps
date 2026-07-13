# Deploy: Cloudflare Pages, one project per app (Direct Upload from CI)

**Decision:** each app is its own Cloudflare Pages project, deployed by CI via
`wrangler pages deploy` (Direct Upload) — not the dashboard Git integration — so builds run through
Turbo (affected-only, cached) and stay reproducible in-repo. The CI workflow is
[`deploy.cloudflare.yml`](./deploy.cloudflare.yml).

## One-time setup per app

Create a Pages project named exactly like the app (`musclemap`, `calmar`, …):

```bash
# Direct-Upload project (no Git connection); production branch is "production".
pnpm exec wrangler pages project create musclemap --production-branch=production
```

Then, in the dashboard (or via API), add the **custom domain** `musclemap.neurodesk.org` to that
project. Each app also ships a `wrangler.toml` (see the app template) so `wrangler pages deploy`
resolves the project name and output dir locally without flags.

## Repo secrets / variables

| Name | Where | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | token with **Cloudflare Pages: Edit** on the account |
| `CLOUDFLARE_ACCOUNT_ID` | secret | target account |
| `TURBO_TOKEN` / `TURBO_TEAM` | secret / var | Turbo remote cache |

## Staging vs production model

- **`push main`** → CI builds affected apps and Direct-Uploads with `--branch=main`. Because each
  project's production branch is `production`, these are **preview (staging)** deployments with a
  stable staging alias per project.
- **`push tag musclemap-v1.2.3`** → CI builds that one app and uploads with `--branch=production`,
  which **is** the project's production branch → the **production** deployment on
  `musclemap.neurodesk.org`.

This keeps `main` as always-staging and makes production explicit, tag-gated, and per app — no global
`v*` tag, no cross-app coupling.

## Cross-origin isolation in production

Each scaffolded app ships [`public/_headers`](./app-template/public/_headers), which Vite copies to
`dist/_headers` and Cloudflare serves at the edge (or use the COI service worker
`coi-serviceworker.js`, already in MuscleMap). The app's Playwright test asserts
`crossOriginIsolated === true`, a worker loads, and the app boots.

## Local dry run

```bash
pnpm --filter musclemap build
pnpm exec wrangler pages deploy apps/musclemap/dist --project-name=musclemap --branch=preview
```
