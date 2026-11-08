---
---

neurodesk-compute 0.3.20261108 (not a workspace package; its version lives in `exes/compute-server/Cargo.toml`): `fetch-image relion` downloads the pinned RELION 5.1.1 Apptainer image (`vnmd/relion_5.1.1:20261107`, mirrored to Hugging Face), `slurm.json` may leave out that image's checksum, a Slurm configuration that leaves a RELION step without a default profile is refused at startup, a failing `scancel` is retried once per poll, commands name the canonical data-root location, symlinked movies are refused, and the server archive includes the Cryo-EM page.
