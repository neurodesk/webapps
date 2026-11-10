---
"cryo-em": patch
---

`neurodesk-compute cryo-em` sets up and starts Cryo-EM on a Slurm cluster in one command: it writes `slurm.json` from `sinfo`, fetches the RELION image and the tutorial, checks the compute nodes after `slurm.json` changes, serves the app on loopback and prints the SSH tunnel command and pairing code. The Standalone dialog's Slurm setup is now three steps.
