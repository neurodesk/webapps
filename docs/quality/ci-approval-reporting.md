# CI approval reporting

The hourly report groups contributor runs awaiting approval and failures that
started no jobs into one GitHub issue. Review linked contributor changes before
approving them through GitHub. The reporter never approves runs and executes
only default-branch code. A failed job-data lookup is shown as unavailable,
so it cannot hide other pending runs or count as a failure without jobs.

Merging `.github/workflows/ci-approvals.yml` into the default branch activates
its schedule. Dispatch `ci-approvals.yml` once after merging to verify it
immediately. The workflow already declares Actions read and issues write access;
no extra token or approval-policy change is needed.

For a read-only preview, supply `GITHUB_REPOSITORY` and an existing `GH_TOKEN`,
then run `node scripts/report-ci-approvals.mjs --dry-run`. Successful and
cancelled runs are excluded. Open a no-job run's annotation to distinguish
expired approval from workflow validation or startup failures.
