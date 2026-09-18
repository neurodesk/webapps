# Vessel Surfer

Pilot a small submarine through an enclosed 3D human vessel lumen and race to a marked destination. This is a homepage easter egg, not a catalog app or standalone release. The "Go surfing" link in the homepage footer opens it at `/surf/`.

## Real human brain data

The default is the **pial arterial vasculature of Subject 02** from Bollmann and colleagues, *Imaging of the pial arterial vasculature of the human brain in vivo using high-resolution 7T time-of-flight angiography*, [eLife 2022;11:e71186](https://doi.org/10.7554/eLife.71186): a whole-brain 7T time-of-flight acquisition at 140 µm isotropic resolution with its artery segmentation, shared on OSF at [doi:10.17605/OSF.IO/NR6GC](https://doi.org/10.17605/OSF.IO/NR6GC). The derived density field, surface and route graph are bundled at build time. The original NIfTI is retained in the pinned Hugging Face dataset. No patient file is fetched from a third party during play.

See [attribution](public/data/ATTRIBUTION.md) for the citation, source revision, checksum and processing changes. The OSF project does not declare a data license; the article is CC BY 4.0. `public/data/brain.json` includes the original file checksum.

The conversion preserves native voxel spacing, reorients RAS coordinates for display, crops foreground bounds, and applies Gaussian smoothing at sigma 0.5 voxel before extracting the surface. The containment field and routes cover the largest connected arterial lumen at native resolution; the overview mesh adds the next largest components up to a voxel budget, and the remaining components appear as a half-resolution overview-only surface that is never used for collision. Links and smoothed samples are validated against the density field and refined against the actual rendered triangles with a 0.015 mm inward margin; branches too thin to hold that clearance are excluded. No vessel dilation, fabricated branches or gap bridging is used. Segmentation artifacts and acquisition resolution remain visible; this is a game rather than a diagnostic model.

To reproduce the assets, download the artery segmentation from OSF (`Subject_02/seg/arteries_seg_TOF_hm_xpace_140um_…_VENP10.nii.gz`) and run:

```sh
uv run --with numpy,scipy,scikit-image,nibabel \
  python site/easter-eggs/vessel-surfer/scripts/prepare-human-network.py /path/to/arteries.nii.gz
```

## Interface

The game is one full-screen canvas. A slim top bar carries the link back to the website, the run timer and bump count, and a pause button. The navigation map sits top right while a run is active. One centred panel serves every other state: the start menu with the Dive button, leaderboard, controls and mask import; the pause menu; and the finish screen with the score submission form. The start menu floats over the slowly rotating vessel network. There is no app shell, theme toggle or About, Cite or Privacy dialog; attribution is a single line in the menu.

## Steering

The camera is exactly at the navigation point inside the lumen and follows the heading. Movement is swept against the source field and actual surface triangles with a small clearance around the eye. A blocked step advances only as far as is safe; turning and reversing remain available. Network view is the menu backdrop only.

- **Mouse**: the pointer's offset from the screen centre is the aim, with a dead zone at the centre and a squared response for fine control. Return the pointer to the centre to fly straight.
- **Touch**: drag anywhere to raise a floating joystick under the finger. Hold the round Stop and Back buttons to brake and reverse.
- **Keys**: WASD or arrows turn and pitch, Shift brakes, B reverses, Space or Escape pauses.
- Turn rates ramp toward the demand (`src/controls.js`), so taps nudge and holds sweep.
- A lumen assist (`src/assist.js`) probes five rays ahead and nudges toward the more open side of the vessel with the authority the player is not using. It never pushes against the player's own input and is off while braking or reversing.
- Forward speed eases down to 30 percent as the wall ahead gets close, so bends can be taken without bumping.
- Roll levels gently back toward world-up so the map and the view agree, except on near-vertical headings.

Optional local NIfTI imports use the same controls. Imports support one scalar 3D segmentation with positive foreground, at most 32 million voxels and 128 MB compressed/decompressed. Custom masks are pooled into a 96³ game grid and reduced to their largest six-connected component. Files stay in the browser and practice runs are not ranked.

## Destination challenge and global leaderboard

The challenge uses a fixed destination 12 mm along a connected route from the same launch point in the widest long arterial trunk. Cruising speed is six voxels per second, so it scales with the data's resolution. Points are `max(0, 10000 - ceil(activeSeconds * 20) - wallBumps * 400)`. Time comes from the monotonic browser clock, independent of the simulation's frame-time cap. Pausing or hiding the tab stops the timer. Holding against a wall is one contact; moving away rearms the bump counter.

A run finishes only within the target radius with a clear line of sight through the lumen. The finish screen asks for a name and sends the name, time and bump count to the leaderboard worker in `../vessel-surfer-leaderboard`, which recomputes the points, validates the run and returns the world rank and top ten. The name is remembered on this device. If the server is unreachable, the run is kept in `localStorage` under `vessel-surfer.scores.v1` and the menu shows this device's best runs instead. The server URL is `VITE_LEADERBOARD_URL` at build time (`src/config.js`).

## Build and validation

```sh
pnpm install
pnpm --filter @neurodesk/vessel-surfer-easter-egg build
pnpm --filter @neurodesk/vessel-surfer-easter-egg test
pnpm --filter @neurodesk/vessel-surfer-easter-egg test:e2e
```

Unit tests densely sample every real route against the vessel field, exercise camera containment over thousands of movement steps, reject exterior camera positions, cover NIfTI validation, junction traversal, the steering model, the lumen assist, roll levelling, and the leaderboard client with and without a server. Browser tests follow the homepage link, exercise the menu states on desktop and phone, keyboard, mouse-aim and joystick steering, touch hold buttons through CDP touch events, the map, timer, mocked global and offline leaderboards, a local mask import, and a complete practice run driven by a mouse-aim autopilot.

The embed is assembled at `/surf/` with noindex metadata. The build downloads SHA-256-verified data from the immutable Hugging Face revision in `data-manifest.json`; the source NIfTI is retained there for provenance and is omitted from the deployed site. Rendering uses [Three.js](https://threejs.org/); NIfTI parsing uses [NIFTI-Reader-JS](https://github.com/rii-mango/NIFTI-Reader-JS).
