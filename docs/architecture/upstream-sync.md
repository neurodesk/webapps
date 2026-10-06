# Upstream sync

QSMbly, SeedSeg and dicompare track Ashley Stewart's repositories
(`astewartau/qsmbly`, `astewartau/prostate`, `astewartau/dicompare-web`).
BrowserQC tracks `niivue/browserqc`. `.github/workflows/upstream-sync.yml` runs every Monday and
opens one pull request per app on `upstream/<id>` with the upstream commits made
since the commit pinned by `source:` in `registry/apps.yml`.

`scripts/sync-upstream.mjs` does the merge. `apps/<id>/upstream.json` holds each
app's rules: upstream paths never imported, text rewritten in paths and
contents, and the adaptations a reviewer keeps when resolving conflicts. Run it
locally with `TMPDIR=/storage/tmp node scripts/sync-upstream.mjs --app <id>`.
The workflow always starts from `main`, including manual runs. Its optional app
input selects one registered app; an empty input syncs every registered app.
When upstream matches the source pin, the script writes nothing.

BrowserQC excludes upstream public assets, standalone layout and styling, and
vendored DICOM code. The pull request lists changes to these files for manual
porting. Scientific source changes still undergo the three-way merge, so
conflicts in QC, ratings, models or processing open a draft for review. Keep
the shared shell, pinned assets and examples, worker cancellation, automation,
model partial-volume estimates and public niimath API described in its rules.

## GitHub App

The workflow pushes and opens pull requests with a GitHub App token. A pull
request opened with `GITHUB_TOKEN` starts no `pull_request` workflows, so CI
would never run on it.

1. Open <https://github.com/organizations/neurodesk/settings/apps/new>.
2. Set **GitHub App name** to `neurodesk-webapps-upstream-sync` and **Homepage URL** to
   `https://github.com/neurodesk/webapps`.
3. Under **Webhook**, clear **Active**.
4. Under **Repository permissions**, set **Contents** and **Pull requests** to
   **Read and write**. Leave everything else at **No access**.
5. Under **Where can this GitHub App be installed?**, select **Only on this
   account**, then select **Create GitHub App**.
6. On the App's page, copy the **Client ID**. Under **Private keys**, select
   **Generate a private key**; the browser downloads a `.pem` file.
7. Select **Install App**, select **neurodesk**, choose **Only select
   repositories**, select **webapps**, then select **Install**.
8. Store the Client ID and the key on the repository, then delete the `.pem`:

   ```sh
   gh variable set UPSTREAM_SYNC_CLIENT_ID --repo neurodesk/webapps --body '<Client ID>'
   gh secret set UPSTREAM_SYNC_PRIVATE_KEY --repo neurodesk/webapps < ~/Downloads/neurodesk-webapps-upstream-sync.*.private-key.pem
   rm ~/Downloads/neurodesk-webapps-upstream-sync.*.private-key.pem
   ```

To rotate the key, generate a new one on the App's page, run the `gh secret set`
command again, and delete the old key there.

## Reviewing a sync pull request

A pull request with conflicts opens as a draft and lists the files. Resolve the
markers on `upstream/<id>` and mark it ready. Once a person has pushed to the
branch, the workflow leaves it alone until it is merged or deleted.

Upstream changes to files the monorepo replaced with shared code are listed under
"Not imported" and are not applied. Port anything relevant by hand.
