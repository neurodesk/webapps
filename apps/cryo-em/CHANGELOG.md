# cryo-em

## 0.1.20261111

### Patch Changes

- 4b3736a: `neurodesk-compute cryo-em` sets up and starts Cryo-EM on a Slurm cluster in one command: it writes `slurm.json` from `sinfo`, fetches the RELION image and the tutorial, checks the compute nodes after `slurm.json` changes, serves the app on loopback and prints the SSH tunnel command and pairing code. The Standalone dialog's Slurm setup is now three steps.
- 4a5c83d: Cryo-EM follows a step the server accepted even when the response to Run was lost on the way back: after a failed submission the page re-reads the project and follows the job it finds running.
- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.1.20261110

### Patch Changes

- 3877250: The musculoskeletal and microscopy catalogues are now titled "MSK Webapps" and "Microscopy Webapps", without "SciGet". The page title and the app bar's "More … web apps" link follow; the SciGet logo and hub link stay.
- b91b41a: Follow a submitted job once: a project refresh still running when Run was clicked no longer attaches a second follower to the new job.

## 0.1.20261109

### Minor Changes

- 6ca6f49: Add Cryo-EM, a microscopy app that runs single-particle analysis with RELION 5.1.1 on the user's own cluster through a single-owner neurodesk-compute server (ADR-0004). It creates and deletes RELION projects, builds each step (import from a data root, motion correction, CTF estimation, LoG picking, extraction, 2D classification, class selection, initial model, 3D refinement, mask creation, post-processing) as a form generated from the shared `@neurodesk/cryo-em` command table, checks it with the servers' own validation, and follows the job in the status bar. Results open in the page: micrographs and maps in NiiVue, class averages as a grid whose clicked classes fill Class selection, and the gold-standard FSC curve with the final resolution. The RELION tutorial (EMPIAR-10204 subset, CC0) is the example: the app downloads its pinned SHA256SUMS, checks the server's `examples` data root holds every movie, and fills the tutorial's settings. Its Standalone dialog walks through installing the server on a Slurm cluster: fetching the RELION image and tutorial, writing `slurm.json`, checking the compute nodes, starting the server and connecting through an SSH tunnel.

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/cryo-em@0.2.0
  - @neurodesk/webapp-components@0.26.0
