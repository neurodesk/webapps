# Third-party notices

`neurodesk-compute` itself is MIT licensed (see `LICENSE`). It runs, but does
not embed, the software below.

## NeSVoR

NeSVoR (Neural Slice-to-Volume Reconstruction), Copyright (c) 2022 Junshen Xu,
MIT License, <https://github.com/daviddmc/NeSVoR>. The server executes NeSVoR
0.5.0 inside the Neurodesk container `vnmd/nesvor_0.5.0`
(`sha256:4a9b346297bd5c10af4047745b6fa82f2912e06c8fecaab615f2adcb32599f64`) or
the equivalent `nesvor_0.5.0_20260722.simg`, built by
<https://github.com/NeuroDesk/neurocontainers>. The container also contains
PyTorch (BSD-3-Clause), tiny-cuda-nn (BSD-3-Clause), MONAI (Apache-2.0),
SVoRT/NiftyMIC-derived components and the NVIDIA CUDA runtime under NVIDIA's
EULA; see the container's own notices.

## RELION

RELION 5.1.1, GPL-2.0, <https://github.com/3dem/relion>, with CTFFIND 4.1.14
(Janelia Research Campus Software License 1.2). In single-owner mode on Slurm
the server runs them inside the Neurodesk `relion` container image the
operator names in `--slurm-config`, built by
<https://github.com/NeuroDesk/neurocontainers>; see the container's own
notices. The server embeds only the relion tool's command table from this
repository (`packages/cryo-em`, MIT) and never links RELION.
`fetch-example relion-tutorial` downloads EMPIAR-10204 tutorial data (CC0) at
run time; none of it is embedded.

## Rust crates

Exact versions are pinned in `Cargo.lock` (`cargo metadata` lists them all).
Direct dependencies:

- `axum`, `axum-server`, `tower`, `tower-http`, `tokio`, `tokio-stream`,
  `tokio-util`, `tracing`, `tracing-subscriber`, `async-stream` — MIT.
- `hyper`, `http` (transitive HTTP stack) — MIT / MIT OR Apache-2.0.
- `serde`, `serde_json`, `clap`, `chrono`, `rand`, `dirs`, `humantime`,
  `futures-util`, `flate2` — MIT OR Apache-2.0.
- `miniz_oxide` (via `flate2`) — MIT OR Zlib OR Apache-2.0.
- `rcgen` — MIT OR Apache-2.0.
- `rustls` — Apache-2.0 OR ISC OR MIT.
- `ring` (crypto provider for `rustls` and `rcgen`) — Apache-2.0 AND ISC;
  includes BoringSSL-derived code (ISC / OpenSSL licence).
- `if-addrs` — MIT OR BSD-3-Clause.
- `regex` (with `regex-automata`, `regex-syntax`) — MIT OR Apache-2.0.
- `reqwest` (`fetch-example` downloads) — MIT OR Apache-2.0; `hyper-rustls` —
  Apache-2.0 OR ISC OR MIT; `webpki-roots` (Mozilla's CA certificates) —
  CDLA-Permissive-2.0.

Development-only: `tempfile` (MIT OR Apache-2.0).
