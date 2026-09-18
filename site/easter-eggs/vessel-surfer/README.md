# Vessel Surfer

Pilot a small submarine through an enclosed 3D human vessel lumen and race to a marked destination. This is a private homepage easter egg, not a catalog app or standalone release. Tap the small footer diamond five times within four seconds between taps to open it.

## Real human brain data

The default is **IXI322-IOP-0891**, a human brain MRA vessel segmentation published by Bizjak and colleagues in the [IXI vascular segmentation dataset](https://github.com/zbizjak/IXI-vascular-segmentation-Dataset/tree/8f5f632fd0567e8770b09acd9057bdbb1a2ac6b9). It replaces the generated network entirely. The derived density field, surface and 243-segment route graph are bundled at build time. The original NIfTI remains in the pinned Hugging Face dataset. No patient file is fetched from a third party during play.

Source and derived data are **CC BY-NC-SA 4.0**. See [attribution](public/data/ATTRIBUTION.md) for authors, citations, license, source revision and processing changes. `public/data/ixi322.json` includes the original file checksum. The data is not covered by a more permissive software license.

The conversion preserves native voxel spacing, reorients RAS coordinates for display, crops foreground bounds, and applies Gaussian smoothing at sigma 0.5 voxel before extracting the surface. Routes are extracted from the largest connected lumen. Links and smoothed samples are validated against the density field and refined against the actual rendered triangles with a 0.015 mm inward margin. Connections that fail continuous triangle containment are excluded from the derived graph used for spawning and beacon placement. Smaller disconnected regions remain visible in Network view. No vessel dilation, fabricated branches or gap bridging is used. Segmentation artifacts and acquisition resolution remain visible; this is a game rather than a diagnostic model.

To reproduce the assets, run `pnpm install`, install numpy, scipy, nibabel and scikit-image, download the pinned repository's `Dataset.zip`, then run:

```sh
python site/easter-eggs/vessel-surfer/scripts/prepare-human-network.py /path/to/Dataset.zip
```

## Tunnel and controls

Both the real brain and imported masks use direct, camera-relative free steering. The camera is exactly at the navigation point inside the lumen and follows the player's heading without chase-camera lag. Movement is swept against the source field and actual surface triangles, with a small clearance around the eye. A blocked step advances only as far as is safe; turning and reversing remain available. The opaque vessel surface stays intact. Network view pauses play; resuming returns inside the tunnel.

- Left/right or A/D: turn immediately. Up/down or W/S: pitch immediately.
- Drag in the tunnel to aim in both axes. Aim into an opening to take a branch.
- Hold Stop or Shift to brake while turning. Hold Back or B to reverse without changing your view.
- Set forward speed in Helm controls. Space or the play/pause control pauses/resumes.

Optional local NIfTI imports use free steering (arrows or dragging), braking and reverse. Their navigation/camera point uses trilinear containment and swept movement against the same field as the rendered isosurface. Imports support one scalar 3D segmentation with positive foreground, at most 32 million voxels and 128 MB compressed/decompressed. These custom masks are pooled into a 96³ game grid and reduced to their largest six-connected component. This reduced-resolution importer is separate from the bundled native-resolution human dataset. Files stay in the browser.

## Build and validation

```sh
pnpm install
pnpm --filter @neurodesk/vessel-surfer-easter-egg build
pnpm --filter @neurodesk/vessel-surfer-easter-egg test
pnpm --filter @neurodesk/vessel-surfer-easter-egg test:e2e
```

Unit tests densely sample every real route against the vessel field, exercise camera containment and clear viewing rays over thousands of movement steps, reject exterior camera positions, and cover NIfTI validation and continuous junction traversal. Browser tests exercise the human dataset on desktop/phone, pause/restart, local mask import, retained inputs, braking/turning/reverse, and light/dark interfaces. Public HTTPS page, asset loading and actual tunnel movement are checked through the existing reverse proxy.

The full catalog build remains blocked in this checkout by Easy MP2RAGE's unavailable `wasm-pack`. The required root interface/mobile/workflow commands encounter other apps' missing production bundles; these failures are not counted as passes. Vessel Surfer's own fresh production bundle is tested separately.

Rendering uses [Three.js](https://threejs.org/); NIfTI parsing uses [NIFTI-Reader-JS](https://github.com/rii-mango/NIFTI-Reader-JS). Shared navigation and About/Cite/Privacy use the Neurodesk shell.

Keyboard arrows work with helm buttons focused; hold buttons also support Enter/Space, expose their pressed state, and track keyboard/touch holds independently. Direct steering is tested in place while braking, including screen-relative pitch/yaw and safe movement toward real walls.

## Map and destination challenge

The compact map shows the vessel network, the player's heading and position, the start square, and the gold destination diamond. Switch between top and front projections to resolve depth. The map follows the player and keeps the target in view; the readout gives straight-line distance and relative height. The gold reference route on the brain map follows validated centerlines and does not constrain steering.

The IXI322 challenge uses a fixed destination 12 mm along a connected route from the same spawn. Points are `max(0, 10000 - ceil(activeSeconds * 20) - wallBumps * 400)`. Time comes from the monotonic browser clock, independent of the simulation's frame-time cap. Pausing, opening Network view, hiding the tab, or opening an About/Cite/Privacy dialog stops the timer. Holding against a wall is one contact; moving away rearms the bump counter. Restart resets the run and preserves the destination.

A run finishes only within the target radius with a clear line of sight through the lumen. The five best completed brain runs persist in localStorage under `vessel-surfer.scores.v1`. The table is local to this browser, not a shared online leaderboard. Storage failures do not stop play and are reported on completion. Imported masks get their own map and a practice destination; their results never mix with the brain challenge rankings.

The embed is assembled at `/_play/vessel/` with noindex metadata and a top-level redirect to the homepage. Closing the overlay removes its iframe, stopping the game. Browser tests open it through the actual footer trigger. The build downloads SHA-256-verified data from the immutable Hugging Face revision in `data-manifest.json`; source NIfTI is retained there for provenance and is omitted from the deployed site.
