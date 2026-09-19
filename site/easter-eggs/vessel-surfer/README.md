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

The game is one full-screen canvas. A slim top bar carries the link back to the website, the run timer and bump count, and a pause button. The navigation map sits top right while a run is active. One centred panel serves every other state: the start menu with the Dive button, the scoring rule, leaderboard, controls and mask import; the pause menu; and the finish screen with the points breakdown and the score submission form. The start menu floats over the slowly rotating vessel network. There is no app shell, theme toggle or About, Cite or Privacy dialog; attribution is a single line in the menu.

### Finding the way

- **Gold trail**: the validated reference route is laid along the vessel floor as gold runway lights (`reset()` in `src/main.js` lowers each route sample onto the wall with the lumen probe), so it never sits in the eye's way. The destination is a gold ring.
- **Destination marker**: a screen-space diamond with the straight-line distance sits over the ring while it is in view; otherwise a chevron at the screen edge points toward it.
- **3D map** (`src/navigation-map.js`): the game renderer draws a second view into the map window through a scissor rectangle on the same canvas, so the map shows the real vessel surface rather than a line sketch. The whole-brain framing is the default and shows the full vasculature; the toggle zooms to a route framing that follows the player heading-up and keeps the player and destination in view. A cyan cone is the player, the gold line and sphere are the route and destination, and the white dot is the start. The map has no fog and its own markers; the tunnel-only trail, beacon and headlamp are hidden during that pass.
- **Coaching**: the first seconds of a run and any wall contact show a one-line hint at the bottom of the screen.

## Steering

The camera is exactly at the navigation point inside the lumen and follows the heading. Movement is swept against the source field and actual surface triangles with a small clearance around the eye. A blocked step advances only as far as is safe; turning and reversing remain available. Network view is the menu backdrop only.

- **Mouse**: the pointer's offset from the screen centre is the aim, with a dead zone at the centre (drawn as a small ring) and a squared response for fine control. Return the pointer to the ring to fly straight. Aim is tracked on the window, so passing over the map or the top bar does not drop a turn; only leaving the window centres it.
- **Speed**: one cruising speed from 0.25× to 3× (0.5× by default, remembered on the device under `vessel-surfer.speed.v1`) is shown on the menu slider and on an in-run slider at the bottom left, and changes mid-run with `+`/`-` (also `]`/`[`) or the mouse wheel.
- **Touch**: drag anywhere to raise a floating joystick under the finger. Tap Turn to turn around; hold the round Stop and Back buttons to brake and reverse.
- **Keys**: WASD or arrows turn and pitch, R turns around, Shift brakes, B reverses, Space or Escape pauses.
- **U-turn** (`UTurn` in `src/controls.js`): one press sweeps the heading exactly 180 degrees at a steady rate toward the more open side of the lumen while forward motion pauses, so reversing direction never depends on timing a spin.
- Turn rates ramp toward the demand (`src/controls.js`), so taps nudge and holds sweep. The full-deflection rate is about 100 degrees per second.
- A lumen assist (`src/assist.js`) probes five rays ahead and nudges toward the more open side of the vessel with the authority the player is not using. It never pushes against a deliberate input (inputs below a small threshold do not count) and is off while braking or reversing. Pinned on a wall, it probes 60 degrees round instead of 30, takes full strength, and only a firm input overrides it, so a sharp bend never traps the sub.
- Forward speed eases down to 30 percent as the wall ahead gets close, so bends can be taken without bumping, and stops once the nose is on the wall so turning away is free.
- The near clip plane sits far inside the eye clearance. Previously the corners of the near plane could cut through a wall the eye was pinned against, opening a dark window onto the fogged outside; inside the vessel the fog and clear colour are now a deep red so distant walls fade rather than turning black.
- Roll levels gently back toward world-up so the map and the view agree, except on near-vertical headings.

Optional local NIfTI imports use the same controls. Imports support one scalar 3D segmentation with positive foreground, at most 32 million voxels and 128 MB compressed/decompressed. Custom masks are pooled into a 96³ game grid and reduced to their largest six-connected component. Files stay in the browser and practice runs are not ranked.

## Destination challenge and global leaderboard

The challenge (`pial-arteries-v2`) is the longest simple path through the route graph from the launch point in the widest long arterial trunk, in either direction, restricted to branches whose lumen stays at least 0.15 mm wide (`humanChallenge` in `src/navigation-map.js`): 33.6 mm over 29 branches with one 63-degree bend. Cruising speed is six voxels per second at 1×, so it scales with the data's resolution. Points make the speed-versus-accuracy trade-off explicit: a **speed score** of `round(80000 / activeSeconds)` minus a **wall penalty** of `400 * wallBumps`, floored at zero (`src/race.js`). At 1× the route takes about 40 s for 2,000 points; at 3× a clean run earns about 6,000, and each bump costs the equivalent of several seconds. The finish screen lists both parts with the average speed. Time comes from the monotonic browser clock, independent of the simulation's frame-time cap. Pausing or hiding the tab stops the timer. Holding against a wall is one contact; moving away rearms the bump counter. Scores from the earlier 12 mm `pial-arteries-v1` challenge stay in the database under their own id and are no longer shown.

A run finishes only within the target radius with a clear line of sight through the lumen. The finish screen asks for a name and sends the name, time and bump count to the leaderboard worker in `../vessel-surfer-leaderboard`, which recomputes the points, validates the run and returns the world rank and top ten. The name is remembered on this device. If the server is unreachable, the run is kept in `localStorage` under `vessel-surfer.scores.v2` and the menu shows this device's best runs instead. The server URL is `VITE_LEADERBOARD_URL` at build time (`src/config.js`).

## Build and validation

```sh
pnpm install
pnpm --filter @neurodesk/vessel-surfer-easter-egg build
pnpm --filter @neurodesk/vessel-surfer-easter-egg test
pnpm --filter @neurodesk/vessel-surfer-easter-egg test:e2e
```

Unit tests densely sample every real route against the vessel field, exercise camera containment over thousands of movement steps, reject exterior camera positions, cover NIfTI validation, junction traversal, the steering model, the U-turn, the lumen assist, roll levelling, and the leaderboard client with and without a server. Browser tests follow the homepage link, exercise the menu states on desktop and phone, keyboard, mouse-aim and joystick steering, the R key U-turn, touch hold buttons through CDP touch events, the map and its framing toggle, timer, mocked global and offline leaderboards, a local mask import, and a complete practice run driven by a mouse-aim autopilot.

The embed is assembled at `/surf/` with noindex metadata. The build downloads SHA-256-verified data from the immutable Hugging Face revision in `data-manifest.json`; the source NIfTI is retained there for provenance and is omitted from the deployed site. Rendering uses [Three.js](https://threejs.org/); NIfTI parsing uses [NIFTI-Reader-JS](https://github.com/rii-mango/NIFTI-Reader-JS).
