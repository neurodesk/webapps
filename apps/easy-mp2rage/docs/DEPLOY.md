# Deploying the web app

The app is a static, 100%-client-side site (Rust core compiled to WebAssembly).
It's published to **GitHub Pages** by the `Deploy to GitHub Pages` Action, which
builds the WASM and uploads `web/`. Single-threaded + SIMD, so **no COOP/COEP
headers are needed** — it runs on plain GitHub Pages.

## One-time setup (you — needs the GitHub UI)

1. **Push** these files to `main` (includes `.github/workflows/deploy-pages.yml`).
2. In the repo, go to **Settings → Pages → Build and deployment** and set
   **Source = "GitHub Actions"**. (That's the only click; you do *not* pick a branch.)
3. The push in step 1 triggers the deploy. To run it by hand instead: **Actions**
   tab → **Deploy to GitHub Pages** → **Run workflow**.

Your site will be at:

```
https://mp2rage.neurodesk.org/
```

Every later push to `main` re-deploys automatically. `CI` (tests + WASM build +
the headless data-path check) runs on every push/PR.

## How the deploy works

`build` job: `tools/stage_core.sh` (stages the committed WASM core from
`packages/easy-mp2rage` into `web/vendor/easy-mp2rage/`) → upload `web/` as the Pages artifact. `deploy` job publishes it.
All asset paths are relative, so it works at the custom-domain root with no config.

## NeuroDesk custom domain + listing

NeuroDesk provided the domain **`mp2rage.neurodesk.org`** and set up the DNS. To
finish (needs the GitHub UI):

1. `web/CNAME` already contains `mp2rage.neurodesk.org`, so the deploy serves it
   there.
2. In the repo, go to **Settings → Pages → Custom domain**, enter
   `mp2rage.neurodesk.org`, and Save. Wait for the DNS check to pass, then tick
   **Enforce HTTPS**.
3. Tell the NeuroDesk team it is live so they add it to
   <https://neurodesk.org/getting-started/hosted/webapps/>.

## Analytics

The shared Neurodesk hosting shell loads Google Analytics 4 for page views only.
It makes no analytics request when Do Not Track or Global Privacy Control is
enabled and never sends images, results, or custom events. `web/index.html` itself
contains no analytics bootstrap, so a standalone deployment is not tracked.

## Notes

- The application runtime (WASM, viewer, workers) is self-contained. Image
  processing always happens in the visitor's browser and the static host never
  sees patient-derived data.
