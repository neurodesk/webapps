# CI failure triage

Run `pnpm check:ci` before submitting changes. It performs a frozen install under
pnpm's dependency-age policy, checks catalog integration, and checks dependency
references. New app jobs also wait for the integration checks in `app-plan`.
For a dependency published within 24 hours, wait or add the reviewed exact version
to `minimumReleaseAgeExclude`; do not disable the policy globally.

`pnpm new-app` registers offline assets, a pass-through offline workflow, a
standalone exception and the rollout row. Replace the template workflow with a
scientific output check when implementing the method. Remove its exception in
`registry/standalone-exceptions.json` when adding its command-line release.
Literal About dialog headings must match the title in `registry/apps.yml`.

The hourly CI approval report maintains one GitHub issue, grouped by commit and
approval/no-job status. Review the linked contributor changes before approving
runs through GitHub. The reporter never approves runs and never executes PR
code. No-job failures require their run annotation to distinguish expired
approval from workflow validation or startup failures. Successful and cancelled
runs are excluded from failure counts. The report becomes active after its
workflow is merged into the default branch; `workflow_dispatch` also uses the
default branch's code.

To inspect the report without posting an issue, supply `GITHUB_REPOSITORY` and
an existing authenticated `GH_TOKEN`, then run
`node scripts/report-ci-approvals.mjs --dry-run`.

Download and deployment checks retry transient DNS/reset failures and HTTP
502/503/504, at most three times beyond the initial attempt. Downloads still
verify pinned hashes. Authentication errors, 404s, corrupt data and scientific
assertions fail immediately. Existing browser example requests retain their
429-only retry policy.

NODDI's release validation compares each input filename and checksum before
running inference. A mismatch reports the platform, Node version, filename and
both hashes. Investigate that input before rerecording references; output parity
and exact input checks must remain strict.
