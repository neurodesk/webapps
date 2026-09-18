# Issue-driven webapp requests with agentic builds and hosted previews

Status: ready for implementation planning review
Note (2026-09-18): the Cloudflare Pages deployment workflow, `wrangler.toml` and `site.cloudflare_project` were removed from the repository. Hosted previews would need a different host or a new Pages project.
Prepared: 2026-08-30
Rigor: high

## Executive decision

Let anyone open a structured GitHub issue that requests either a change to an existing
catalog webapp or a brand-new webapp. A maintainer approves the request with a label.
A GitHub Agentic Workflow (gh-aw) then implements the request on a branch, opens a pull
request that closes the issue, and every push to that pull request publishes a hosted
preview of the full composite site on Cloudflare Pages at
`https://<branch>.neurodesk-webapps.pages.dev/<app-path>/`. Merging the pull request
lands the app in the production composite site through the existing `deploy-pages`
workflow; standalone `release-apps` bundles stay a separate, manual maintainer step.

Three properties are fixed by this decision:

1. **The catalog stays the source of truth.** Issue forms, preview comments, and the
   agent brief derive app ids, paths, categories, and runtimes from `registry/apps.yml`
   through `scripts/lib/apps-registry.mjs`. Nothing in `.github/` repeats an app list.
2. **The agent never writes to GitHub directly.** It runs with a read-only token inside
   gh-aw's sandbox; pull requests, branch pushes, comments, and labels go through gh-aw
   safe outputs after a threat-detection job. Humans still review and merge.
3. **Previews are the real artifact.** The preview job runs the same `pnpm build`,
   `pnpm audit:artifacts`, and `pnpm test:smoke` gates as `ci` and `deploy-pages`, so a
   green preview is evidence that the merge will deploy.

Do not enable the agentic trigger for unlabelled issues. Public-repo issue authors are
untrusted input; the maintainer label is the trust boundary.

## Verified starting point

- Production host is GitHub Pages at `webapps.neurodesk.org` (`build_type: workflow`,
  source `main`). `deploy-pages.yml` runs on every push to `main` and nightly, builds
  the composite `dist/`, audits budgets, deploys, and verifies cross-origin isolation
  against the live URL. This is already "the main release of all webapps".
- One repository has exactly one GitHub Pages site. Pull-request previews cannot be
  hosted on Pages without a second repository.
- `deploy-cloudflare.yml` already deploys the identical artifact to the Cloudflare Pages
  project `neurodesk-webapps` (`wrangler.toml`, `registry/apps.yml` `site.cloudflare_project`),
  but it is `workflow_dispatch` only and **the `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` secrets are not configured** (`gh secret list` shows only the
  two GA4 secrets). Cloudflare direct upload with `--branch=<name>` other than the
  production branch creates a preview deployment with the alias
  `https://<branch>.<project>.pages.dev`; previews are unlimited and honour `_headers`.
- `scripts/audit-artifacts.mjs` already enforces Cloudflare's 25 MiB per-file limit and
  the 20,000-file, 100 MiB per-app, and 750 MiB site budgets (ADR-0002), so the
  composite artifact is preview-deployable by construction.
- Every bundled app derives `base` from its registry `path` (`scripts/lib/vite-app-config.mjs`),
  and `scripts/build-site.mjs` places each app at `dist/<path>/`. The composite site is
  origin-independent apart from `_headers`, canonical URLs, and analytics.
- `pnpm new-app <id>` scaffolds `apps/<id>` from `templates/app-template` and appends a
  validated catalog entry with `support_status: experimental`, `source: neurodesk/webapps@local`,
  and `ci.release: false`. The registry rejects `active` apps without a pinned
  40-character commit source, so a new in-repo app is experimental until a maintainer
  promotes it.
- `scripts/lib/app-plan.mjs` selects an app when any `apps/<id>/` path changes and the id
  exists in the registry; `registry/apps.yml` and `pnpm-lock.yaml` changes are treated as
  non-code. A new app therefore selects only itself in `ci` unless shared code changes.
- `ci.yml` runs on `pull_request` with `permissions: contents: read`; it already has an
  `app-plan` job and a `composite-site` job whose steps are duplicated verbatim in
  `deploy-pages.yml` and `deploy-cloudflare.yml`.
- No `.github/ISSUE_TEMPLATE/`, no gh-aw workflow, and no `gh aw` extension exist yet.
  Repository labels are only `bug`, `documentation`, `enhancement`, `good first issue`.
- `AGENTS.md` contains only the Caddy remote-preview procedure. It does not tell an
  agent how to add or change a webapp, which the agentic brief must do.
- Builds reach `huggingface.co`, `files.au-1.osf.io`, `cdn.jsdelivr.net`, `github.com`,
  `rustwasm.github.io`, and npm. That is the minimum outbound allowlist for the agent
  sandbox.

## gh-aw facts this plan relies on

- Workflows are Markdown files in `.github/workflows/*.md` with YAML frontmatter and are
  compiled by `gh aw compile` into committed `*.lock.yml` files. The lock file is what
  Actions runs.
- Triggers: `issues: types: [labeled] names: [...]`, `slash_command:` with `events:`,
  `roles:` (default `[admin, maintainer, write]`), `reaction:`, `status-comment:`,
  `manual-approval: <environment>`.
- `engine: { id: claude, model: ... }` needs the `ANTHROPIC_API_KEY` secret;
  `engine: copilot` needs a Copilot subscription. The plan defaults to `claude` because
  the repository already carries Anthropic-model conventions; see open decisions.
- `steps:` run deterministic setup before the agent, `post-steps:` after it,
  `cache:` pre-warms dependencies, `network: allowed:` is a domain allowlist enforced by
  the workflow firewall, `timeout-minutes`, `max-turns`, `max-ai-credits`, and
  `max-daily-ai-credits` cap cost.
- Safe outputs used: `create-pull-request` (`branch`, `title`, `body`, labels, draft,
  base, `protected-files: fallback-to-issue`), `push-to-pull-request-branch`
  (`target: triggering`, required labels), `add-comment`, `add-labels`, and the mandatory
  `noop` / `missing-data` / `missing-tool` reports. Issue and comment text is sanitized
  before it reaches the agent; on public repositories content from non-collaborators is
  filtered unless a collaborator's action triggers the run.

## Gaps in the current repository

### Blocking

1. No preview hosting path exists for pull requests. Pages is single-site and the
   Cloudflare secrets are absent.
2. The composite build steps are copied into three workflows. A fourth copy for previews
   would make the "derive from the catalog, never repeat" rule fail at the workflow level.
3. Nothing gates who can start an agent run or how much it may spend.
4. `AGENTS.md` does not describe the app-change and new-app contracts (registry entry,
   `pnpm new-app`, runtime adapters, test scripts, asset manifests, licences).
5. There is no structured intake, so an agent would have to guess app ids, categories,
   upstream sources, and licences from free text.

### Quality and provenance

- New apps often need scientific assets on Hugging Face. The agent cannot upload assets;
  the flow must let it stop with a clear `missing_data` request instead of committing
  binaries.
- Preview builds must not report to production GA4 or be indexed by search engines.
- A preview URL is only useful if the comment names the affected app paths, not just
  the site root.
- Merged PRs should tell the original issue where the app now lives.

## Target design

### 1. Intake: two issue forms derived from the catalog

`.github/ISSUE_TEMPLATE/webapp-change.yml` and `webapp-new.yml`.

Change form fields: app (dropdown of catalog ids and titles), requested behaviour,
acceptance criteria, sample data or reproduction, out-of-scope notes. Auto labels:
`webapp-request`, `webapp:change`.

New-app form fields: proposed id (kebab-case), title, one-sentence description,
category (dropdown of `site.categories`), upstream tool and repository, licence, runtime
hint (dropdown of `RUNTIMES`), scientific assets and their sources, keywords. Auto labels:
`webapp-request`, `webapp:new`.

The dropdowns are generated by a new `scripts/sync-issue-forms.mjs` that reads the
registry through `loadAppsRegistry()` and rewrites the two YAML forms.
`test/issue-forms.test.mjs` fails when the committed forms drift from the registry, the
same way `test:registry` protects the catalog.

### 2. Trust gate: maintainer label

Labels created once: `webapp-request`, `webapp:change`, `webapp:new`, `agent:build`,
`agent:built`, `agent:needs-input`, `preview`.

A maintainer reads the issue, edits it if needed, and adds `agent:build`. Only that
labelled event starts the agent, and `roles: [admin, maintainer, write]` rejects labels
applied by anyone else. Removing and re-adding the label re-runs the build.

### 3. Agentic build workflow: `.github/workflows/webapp-request.md`

Frontmatter (illustrative; exact values are fixed in Unit 4):

```yaml
on:
  issues:
    types: [labeled]
    names: [agent:build]
  roles: [admin, maintainer, write]
  reaction: eyes
  status-comment: true
permissions:
  contents: read
  issues: read
  pull-requests: read
engine:
  id: claude
runtimes:
  node:
    version: "22"
steps:
  - uses: pnpm/action-setup@v6
  - run: pnpm install --frozen-lockfile
  - run: pnpm exec playwright install --with-deps chromium
cache:
  key: pnpm-${{ hashFiles('pnpm-lock.yaml') }}
  path: ~/.local/share/pnpm/store
network:
  allowed: [defaults, node, "huggingface.co", "files.au-1.osf.io", "cdn.jsdelivr.net", "rustwasm.github.io"]
tools:
  github:
    toolsets: [default]
  bash: ["pnpm *", "node *", "git *", "ls *", "cat *", "grep *", "find *"]
  playwright:
timeout-minutes: 60
max-turns: 150
max-ai-credits: 300
max-daily-ai-credits: 1500
concurrency:
  group: webapp-request-${{ github.event.issue.number }}
  cancel-in-progress: true
safe-outputs:
  create-pull-request:
    title-prefix: "[webapp] "
    labels: [webapp-request, preview]
    draft: true
    base: main
    protected-files: fallback-to-issue
  add-comment:
    max: 2
  add-labels:
    allowed: [agent:built, agent:needs-input]
    max: 2
```

Body (the agent brief) is deterministic prose that:

- Points the agent at `AGENTS.md`, `CONTEXT.md`, `README.md`, and
  `docs/architecture/component-adoption.md`, and states the catalog-first rule.
- For `webapp:change`: locate the app from the issue's app id, keep changes inside
  `apps/<id>/` unless the issue explicitly asks for shared changes, add or update tests,
  and bump `apps/<id>/package.json` version per the app's convention.
- For `webapp:new`: run `pnpm new-app <id> --runtime ... --shell ... --category ...
  --title ... --description ... --keywords ...`, implement the workflow in the scaffold,
  never commit files above 1 MiB or any model weights, and leave `support_status:
  experimental` and `ci.release: false` untouched.
- Requires the gate commands before submitting: `pnpm test:registry`,
  `node scripts/app-plan.mjs --only <id>`, `pnpm --filter <id> lint`, `test`, `build`,
  `test:e2e` when the app declares `ci.browser_test`, and `node scripts/audit-artifacts.mjs --app <id>`.
- Names the branch `webapp/issue-<number>-<slug>` and writes a PR body with
  `Closes #<number>`, a summary, the gate command output, licence provenance, and a
  "Needs from maintainers" section when assets or credentials are missing.
- On blocked work: `add_comment` on the issue with the precise question, `add_labels`
  `agent:needs-input`, and `missing_data`; never open an empty PR.

The compiled `webapp-request.lock.yml` is committed alongside the Markdown.

### 4. Revision loop: `.github/workflows/webapp-revise.md`

Trigger `slash_command: { name: revise, events: [pull_request_comment] }` with the same
roles. Safe output `push-to-pull-request-branch` with `target: triggering`,
`required-labels: [webapp-request]`, `required-title-prefix: "[webapp] "`, plus
`add-comment`. The brief is the build brief plus "apply the review comment on this PR,
keep unrelated files untouched, rerun the gates". Ordinary human pushes to the branch
remain possible; the agent is one contributor among others.

### 5. Preview hosting: `.github/workflows/preview.yml` (deterministic Actions)

- Trigger `pull_request: types [opened, synchronize, reopened, labeled]` restricted to
  same-repository head branches (fork PRs do not receive secrets and are skipped with a
  comment). Runs when the PR carries the `preview` label or the head branch matches
  `webapp/*`; maintainers can add `preview` to any PR.
- Reuses one new reusable workflow `.github/workflows/build-site.yml` (`workflow_call`)
  extracted from the `composite-site` job in `ci.yml` and the build steps in both deploy
  workflows: checkout, pnpm, turbo cache, Rust toolchain, wasm-pack, `pnpm install`,
  `pnpm build`, `pnpm audit:artifacts`, `node --test test/runtime-assets.test.mjs`,
  `pnpm test:smoke`, then `upload-artifact dist`. `ci.yml`, `deploy-pages.yml`,
  `deploy-cloudflare.yml`, and `preview.yml` call it, so there is one build definition.
- Build inputs `WEBAPPS_PREVIEW=1` and `WEBAPPS_PREVIEW_REF=<pr number>` make
  `scripts/build-site.mjs` and `scripts/lib/composite-theme.mjs` emit
  `X-Robots-Tag: noindex` in `_headers`, drop the GA4 measurement id, and inject a small
  "Preview build for PR #n" banner through the existing composite theme injection.
  `test/build-site.test.mjs` covers both modes.
- Deploys with `pnpm exec wrangler pages deploy dist --project-name=neurodesk-webapps
  --branch="$HEAD_REF" --commit-hash="$HEAD_SHA"`. Cloudflare aliases the deployment at
  `https://<sanitized-branch>.neurodesk-webapps.pages.dev`.
- `scripts/preview-comment.mjs` takes the alias URL and the app-plan `selected_ids`
  output and renders a Markdown table of `https://<alias>/<path>/` links for the
  selected apps (all apps when `all_apps` is true), the commit, and the audit numbers.
  The workflow upserts one sticky PR comment (marker `<!-- webapps-preview -->`) and,
  when the PR body closes an issue, mirrors the links to that issue.
- `test:deployed` runs against the alias URL so cross-origin isolation on previews is
  verified exactly like production.
- On `pull_request: closed`, a small job deletes that branch's Cloudflare preview
  deployments through the Pages API (best effort, non-blocking).
- Concurrency group `preview-<pr number>`, `cancel-in-progress: true`.

### 6. Production release on merge

No new mechanism. `deploy-pages.yml` already deploys `main` and the landing catalog is
rendered from the registry, so a merged new app appears at
`https://webapps.neurodesk.org/<path>/` on the next push. Two small additions:

- `deploy-pages.yml` `deploy` job posts "Deployed to <production url>/<path>/" on every
  issue closed by PRs in the push (`gh api` on the compare range; skipped when none).
- README "Adding an app" grows a "Requesting an app" section that links the issue forms
  and explains the `agent:build` gate, previews, and that standalone `release-apps`
  bundles remain a maintainer decision requiring `ci.release: true`, `support_status:
  active`, and a pinned source.

## Implementation sequence

Each unit is independently mergeable and leaves `pnpm test` green.

### Unit 0: Prerequisites, decisions, and ADR

- Record ADR-0003 "Host pull-request previews on Cloudflare Pages branch aliases and
  gate agentic builds behind a maintainer label" with the alternatives considered
  (second Pages repository, per-PR Pages artifacts, ungated triggers).
- Create the Cloudflare API token scoped to Pages edit on the `neurodesk-webapps`
  project; add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
- Add `ANTHROPIC_API_KEY` (or the Copilot alternative) as a repository secret.
- Create the seven labels. Enable branch protection on `main` requiring `ci` and at
  least one review so agent PRs cannot merge unreviewed.
- Install `gh extension install github/gh-aw` locally; document `gh aw compile` in
  the README development section.

### Unit 1: Catalog-derived issue forms

- `scripts/sync-issue-forms.mjs`, the two forms, `test/issue-forms.test.mjs`, and a
  `sync:issue-forms` root script. Wire the test into `pnpm test`.
- `ci.yml` `workspace-contracts` job runs the new test.

### Unit 2: One reusable composite build

- Extract `.github/workflows/build-site.yml` (`workflow_call` with inputs `preview`,
  `preview_ref`, `run_smoke`, `analytics`) and switch `ci.yml`, `deploy-pages.yml`, and
  `deploy-cloudflare.yml` to call it. Behaviour must be byte-for-byte equal for
  production: compare `dist` checksums from the old and new workflow on the same commit
  before merging.

### Unit 3: Preview mode and preview workflow

- Preview flags in `build-site.mjs` and `composite-theme.mjs` with tests.
- `scripts/preview-comment.mjs` with a unit test over a fixture plan and alias.
- `preview.yml` including fork skip, sticky comment, issue mirror, deployed smoke, and
  close-time cleanup. Validate with a throwaway `webapp/preview-smoke` branch that
  changes one app's title string.

### Unit 4: Agent brief and build workflow

- Extend `AGENTS.md` with "Changing a webapp" and "Adding a webapp" sections that state
  the registry contract, `pnpm new-app`, per-runtime adapters (`build-static.mjs` versus
  Vite), asset-manifest rules, licence recording in `LICENSES.md`, and the gate commands.
  These sections are read by humans and agents alike, so keep them factual.
- Write `webapp-request.md`, compile the lock file, and run it first with gh-aw staged
  mode against a maintainer-authored change issue, then a real one.
- Tune `max-turns`, `timeout-minutes`, and the bash allowlist from the staged run's log.

### Unit 5: Revision loop

- `webapp-revise.md` plus lock file; exercise `/revise` on the Unit 4 PR.

### Unit 6: Post-merge closure

- Issue comment step in `deploy-pages.yml`; README "Requesting an app" section;
  CONTEXT.md entries for "Webapp request", "Preview deployment", and "Agentic build".

### Unit 7: End-to-end drill and cost baseline

- Run one `webapp:new` request for a deliberately small app (for example a NIfTI header
  inspector on `static-esm`) from issue to production. Record wall time, AI credits,
  preview size, and reviewer effort in `docs/architecture/examples/`.
- Decide from that baseline whether `webapp:new` needs `manual-approval: agentic-builds`
  (an environment with required reviewers) in addition to the label gate.

## Verification matrix

| Concern | Check | Where |
| --- | --- | --- |
| Forms match the catalog | `test/issue-forms.test.mjs` | `ci` workspace-contracts |
| Build definition is single-sourced | `dist` checksum parity old versus new workflow | Unit 2 review |
| Preview never leaks to production | `test/build-site.test.mjs` asserts noindex header, no GA4 id, banner present only in preview mode | `pnpm test` |
| Preview links are correct | `test/preview-comment.test.mjs` fixture with subset and all-apps plans | `pnpm test` |
| Preview is isolated | `test:deployed` against the alias URL | `preview.yml` |
| Agent cannot write directly | workflow permissions are read-only; safe outputs own writes; threat detection enabled | lock file review |
| Untrusted authors cannot trigger | `roles:` on both agentic workflows; label gate | staged run by a non-collaborator account |
| Cost bounded | `max-turns`, `max-ai-credits`, `max-daily-ai-credits`, per-issue concurrency | lock file review, Unit 7 baseline |
| No binaries or model weights committed | `audit:artifacts`, PR file-size check in the brief, `protected-files` | `ci`, PR review |
| Merge deploys the app | production URL comment on the closed issue | Unit 7 drill |

## Definition of done

- A maintainer can take a community issue from either form to a draft PR without
  leaving GitHub, by adding one label.
- Every push to a `webapp/*` PR yields a sticky comment with working per-app preview
  URLs, and the same links appear on the originating issue.
- `/revise <instruction>` from a maintainer on the PR pushes a new commit within the
  same branch and refreshes the preview.
- Merging deploys to `webapps.neurodesk.org` through the unchanged Pages pipeline, and
  the issue receives the production URL.
- All four composite workflows call one `build-site.yml`.
- The Unit 7 drill is recorded with time and cost numbers.

## Affected repository areas

- `.github/ISSUE_TEMPLATE/webapp-change.yml`, `webapp-new.yml` (new, generated)
- `.github/workflows/build-site.yml`, `preview.yml` (new); `ci.yml`, `deploy-pages.yml`,
  `deploy-cloudflare.yml` (refactored to call `build-site.yml`)
- `.github/workflows/webapp-request.md` + `.lock.yml`, `webapp-revise.md` + `.lock.yml` (new)
- `scripts/sync-issue-forms.mjs`, `scripts/preview-comment.mjs` (new);
  `scripts/build-site.mjs`, `scripts/lib/composite-theme.mjs` (preview mode)
- `test/issue-forms.test.mjs`, `test/preview-comment.test.mjs`, `test/build-site.test.mjs` (new)
- `AGENTS.md`, `README.md`, `CONTEXT.md`, `docs/adr/0003-*.md`, `package.json` scripts
- Repository settings: secrets, labels, branch protection, optional environment

## Dependencies and open decisions

### Blocking dependencies

- Cloudflare account access to create the Pages token (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`). Without these, Units 3 and 5 cannot be validated.
- An `ANTHROPIC_API_KEY` (Claude engine) or Copilot entitlement (Copilot engine) for
  the gh-aw agent job.

### Decisions to record during implementation

1. **Engine.** Default `claude`; switch to `copilot` if the organisation prefers
   subscription billing over API credits. The Markdown brief is engine-agnostic.
2. **Gate strength for new apps.** Label only, or label plus `manual-approval`
   environment. Decide after the Unit 7 cost baseline.
3. **Preview retention.** Delete on PR close (proposed) versus keep for 30 days.
4. **Fork PRs.** Skipped for previews in this plan. If community code contributions
   should also get previews, add a maintainer-triggered `workflow_dispatch` path that
   checks out the fork ref explicitly; never use `pull_request_target` with a checkout
   of the head.
5. **Promotion path.** How a merged experimental app becomes `active` with a pinned
   source and `ci.release: true`; likely a short maintainer checklist in README rather
   than automation.

## Risks and rollback

- **Prompt injection through issue text.** Mitigated by the maintainer label gate,
  gh-aw sanitization, read-only agent token, safe-output validation, threat detection,
  required CI, and required human review. Residual risk is a maintainer approving a
  malicious request; the review step remains the control.
- **Secret exfiltration from the agent job.** The agent job holds no deployment secrets;
  Cloudflare and GA4 secrets exist only in deterministic workflows. The network allowlist
  blocks other hosts.
- **Runaway cost.** Per-run, per-day, and turn caps; per-issue concurrency cancels
  duplicate runs. Rollback is removing the `agent:build` label trigger by deleting the
  lock file; nothing else depends on it.
- **Preview host drift from production.** Both are the same `dist` from the same
  reusable workflow; `test:deployed` runs on both. If Cloudflare behaviour diverges
  (headers, path handling), the preview comment states it is Cloudflare-hosted and links
  the equivalent production path once merged.
- **Artifact budget pressure.** New apps add to the 750 MiB site budget. The audit runs
  in the preview job, so an over-budget app fails before hosting, and ADR-0002's 500 MiB
  planning threshold still applies.
- **Rollback of the whole feature.** Delete the two `.lock.yml` files and `preview.yml`;
  the reusable build workflow and issue forms are harmless on their own.

## Reproducing the investigation

```bash
gh secret list                                   # only GA4 secrets exist today
gh api repos/neurodesk/webapps/pages             # Pages on main, custom domain
gh label list                                    # four default labels
node scripts/app-plan.mjs --only musclemap       # selection outputs used by previews
grep -n "25 MiB" scripts/audit-artifacts.mjs     # Cloudflare per-file limit already enforced
grep -oh 'https://[^/"]*' runtime-assets/manifest.json models/*.json | sort -u
```

## Evidence sources

- `.github/workflows/{ci,release,deploy-pages,deploy-cloudflare}.yml`
- `scripts/{new-app,build-site,app-plan,audit-artifacts}.mjs`, `scripts/lib/{apps-registry,app-plan,vite-app-config}.mjs`
- `docs/adr/0001-composite-static-site.md`, `docs/adr/0002-hosting-capacity-and-runtime-store.md`
- gh-aw reference: frontmatter, triggers, safe outputs, engines, architecture
  (`https://github.github.com/gh-aw/`)
- Cloudflare Pages limits and `wrangler pages deploy` reference
  (`https://developers.cloudflare.com/pages/platform/limits/`,
  `https://developers.cloudflare.com/workers/wrangler/commands/pages/`)
