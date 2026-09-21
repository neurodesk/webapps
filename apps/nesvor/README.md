# NeSVoR

Fetal and neonatal brain slice-to-volume reconstruction with
[NeSVoR](https://github.com/daviddmc/NeSVoR), run on a compute server in the
user's own network. The browser loads the stacks, prefills slice thicknesses,
pairs masks, offers the upstream protocols (fetal brain, neonatal brain, fetal
body) and reviews the reconstructed volume; the computation happens in the pinned
Neurodesk `nesvor` 0.5.0 container on the machine named in the Compute server
section. Design and rationale: [docs/architecture/nesvor-remote-compute.md](../../docs/architecture/nesvor-remote-compute.md);
wire protocol: [docs/architecture/remote-compute-protocol.md](../../docs/architecture/remote-compute-protocol.md);
server: [exes/compute-server](../../exes/compute-server).

## Layout

- `index.html` — the shared workspace vocabulary with the stack table, the
  compute server section and the reconstruction settings.
- `src/main.js` — shell mount, viewer, stack table, protocol presets, job
  submission through `@neurodesk/webapp-components/compute`.
- `src/spec.js` — presets, job spec validation and the `nesvor` command line.
  The Node reference server (`test-utils/compute-reference-server.mjs`) imports
  this module so both sides validate identically.
- `src/stacks.js` — NIfTI header inspection, thickness defaults, mask pairing.
- `examples.json` — SVRTK's simulated fetal stacks (Apache-2.0), mirrored on the
  Neurodesk Hugging Face dataset.

## Tests

```
pnpm --filter nesvor test        # spec, stacks and config unit tests
pnpm --filter nesvor test:e2e    # built app + reference compute server (simulated nesvor)
node --test test/remote-compute-protocol.test.mjs   # protocol conformance (reference server)
COMPUTE_SERVER_URL=http://127.0.0.1:8765 COMPUTE_SERVER_TOKEN=dev node --test test/remote-compute-protocol.test.mjs
```

The last line runs the same suite against `neurodesk-compute serve --runner simulate --insecure-http --listen 127.0.0.1:8765 --token dev`.

A real reconstruction needs an NVIDIA GPU host; see the server README.
