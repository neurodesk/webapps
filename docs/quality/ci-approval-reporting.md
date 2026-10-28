# CI approval reporting

The hourly report lists current workflow approval and startup blockers in one
GitHub issue. Each open PR has a section with its title, author, current commit,
affected workflow names, run ages and links to the exact attempts.

PR runs must match an open PR's current head or merge commit. Fork runs can have
an empty PR association, so matching also checks the source repository and
branch. Runs from closed or merged PRs and older commits are excluded. For each
remaining workflow, event, source repository, branch and commit, the reporter
reads the latest run and attempt. Current PR heads are fetched without an age
limit, so a contributor's pending approval cannot disappear after seven days.
Attempts at the same commit are ordered by their start time, with run IDs as a
tie-breaker. Successful, cancelled or running attempts supersede older failures.
Exclusion does not establish that checks passed.
Non-PR startup failures remain visible under Other runs within a seven-day
window. A newer run of the same workflow, event and branch supersedes them,
including when it tests a newer commit. This lookup reads all pages in that
window and orders attempts by their start time, so a rerun of an older-created
run cannot be hidden by a newer-created run.

A failure without jobs is not a test failure. The report includes GitHub failure
annotations or check output when the Checks API exposes them. Otherwise, the
cause stays unknown and the run annotation is the next place to inspect.
Large reports omit excess details to fit the issue size limit. Their counts
still include every current blocker, and a link opens the workflow run list.
A failed job-data lookup is shown as unavailable. A failed PR or current-run
lookup aborts reporting, so incomplete data cannot silently close the issue.

Issue comments announce newly blocked PRs or a change in the required action.
Unavailable job data does not trigger a comment and retains the PR's previous
notification state until the lookup recovers. Notification markers precede
detail sections so truncation cannot remove them. Another push to an already
blocked PR and routine age updates do not add comments. The issue closes when
no current PR blocker or recent non-PR startup blocker remains. Failed jobs are
outside this report.

Before posting a notification, the reporter saves its pending delivery ID in
the issue. A retry checks bot-owned comments for that ID before posting again,
then removes completed deliveries. Failed comment requests remain pending;
an interrupted issue update cannot duplicate a comment that already succeeded.
Unknown job probes retain pending deliveries and legacy notification markers
until their status is known again. Resolved blockers discard pending deliveries.

Review linked contributor changes before approving workflows through GitHub.
The reporter never approves runs and executes only default-branch code.

Merging `.github/workflows/ci-approvals.yml` into the default branch activates
its schedule. Dispatch `ci-approvals.yml` once after merging to verify it
immediately. The workflow declares Actions, Checks and pull requests read access,
plus issues write access. No extra token or approval-policy change is needed.

For a read-only preview, supply `GITHUB_REPOSITORY` and an existing `GH_TOKEN`,
then run `node scripts/report-ci-approvals.mjs --dry-run`. This prints the report
without editing the GitHub issue or posting comments.
