Stage all changes, create a commit with a descriptive message, and push to the remote. Follow the standard git commit instructions from the system prompt.

Before committing, increment the patch version in `web/js/app/config.js` (e.g. `0.2.0` -> `0.2.1`) and include the version bump in the same commit.

After pushing, create a GitHub release using `gh release create` with:
- Tag: `v{version}` (e.g. `v0.2.1`)
- Title: the commit message summary
- `--generate-notes` flag for auto-generated release notes
