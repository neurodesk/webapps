# Vessel Surfer leaderboard

A Cloudflare Worker with a D1 database that stores completed Vessel Surfer runs
for the global leaderboard shown in the game.

- `GET /scores?challenge=pial-arteries-v2&limit=10` returns the best runs
  (highest points, then fastest) and the total number of saved runs. The
  challenge is a track id from the game's `TRACKS` table in `race.js`; each
  track has its own board, points scale and minimum plausible time.
- `POST /scores` with `{ challenge, name, seconds, bumps }` saves a run and
  returns its world rank and the current top ten. Points are recomputed on the
  server with the game's own `pointsFor`, names are trimmed to 16 printable
  characters, implausible times are rejected and each address may save at most
  30 runs per hour. Only the name, time and bump count are stored, together
  with a salted hash of the address used for rate limiting.

Browser access is limited to the origins in `ALLOWED_ORIGINS` plus loopback
hosts for local previews.

## Deploy

`.github/workflows/deploy-vessel-surfer-leaderboard.yml` deploys on every push
to `main` that touches this package, using the repository's Cloudflare
secrets. `scripts/ensure-database.mjs` creates the D1 database on first use and
writes its id into `wrangler.toml`; migrations run before the worker deploys.

The game reads `VITE_LEADERBOARD_URL` at build time and defaults to
`https://vessel-surfer-leaderboard.neurodesk.workers.dev`. If the account's
`workers.dev` subdomain differs, set that variable in the site deploy
workflows or attach a custom route to the worker.

```sh
pnpm --filter @neurodesk/vessel-surfer-leaderboard test
pnpm --filter @neurodesk/vessel-surfer-leaderboard dev
```
