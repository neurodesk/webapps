---
---

Remove the unused Cloudflare Pages deployment: its manual workflow never succeeded and webapps.neurodesk.org is served by GitHub Pages. The root wrangler config, the registry's cloudflare_project field and the root wrangler dependency go with it; the per-file artifact budget stays as a generic 25 MiB limit.
