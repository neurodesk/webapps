# SurfAnnotate — agent notes

## Architecture

```
src/
  main.js                   UI wiring, interaction, export. The only DOM-aware file.
  surface/                  Pure geometry and algorithms — no DOM, no NiiVue, all unit-tested
    adjacency.js            CSR 1-ring vertex graph from (vertices, triangles)
    pathfinder.js           A* shortest path along mesh edges; chain building and validation
    edgeAnchor.js           Distance-to-cut field; extends a border out to an open edge
    exclude.js              Cuts a completed ROI out of the graph so its rim is an edge
    parcellation.js         Resolves ordered ROI definitions into disjoint regions
    fill.js                 Flood fill inside a closed boundary, seeded or automatic
    roiSession.js           Drawing state: clicks, trace, fill, landmarks
    vertexLookup.js         Uniform-grid nearest-vertex search
  niivue/                   Every NiiVue call lives here
    meshAdapter.js          Loading, picking, layers, overlays
    colormaps.js            Colour maps NiiVue does not ship
    colorLegend.js          The on-canvas scale — wheel or bar. Pure, unit-tested
    overlayMask.js          Restricting overlays to a binary mask. Pure, unit-tested
    markers.js              Border points and landmarks in screen space. Pure, unit-tested
  io/                       File writers/readers, pure and unit-tested
    freesurferLabel.js, gifti.js, points.js, naming.js, classify.js, geometryOffset.js
    freesurferCurv.js       Curv format read honestly — NiiVue's reader inverts
    freesurferAnnot.js      .annot writer (and reader, for round trips)
    parcellationExport.js   The ROI list as one label per vertex
    session.js              Definitions + landmarks as JSON; rides in .label.gii metadata
```

The split matters: `surface/` and `io/` run under plain `node --test` with no browser,
which is why the algorithm suite is fast and deterministic. Only `main.js` and
`niivue/` need a WebGL context.

## Key conventions

- **All NiiVue *mesh* access goes through `src/niivue/meshAdapter.js`.** Construction
  and the canvas (`new Niivue`, `attachToCanvas`, `setSliceType`, `drawScene`,
  `removeMesh`) stay in `main.js`, and colormaps in `niivue/colormaps.js`; it is the
  mesh, layer and picking surface that is centralised, and that is what the 1.0.0-rc
  rewrite changes. 1.0.0-rc.x is a
  ground-up rewrite (`pts`/`tris` → `positions`/`indices`, camelCase layer fields, no
  `indexNearestXYZmm`), so keeping the surface area in one file makes that migration a
  single-file change. Pin stays at **0.69.0** — npm `latest`, and byte-identical mesh
  code to the 0.68.x the rest of this monorepo uses.
- **The favicons in `public/` are generated — run `node icon/render.mjs`, do not edit
  the PNGs.** `icon/surfannotate.svg` is the master and is deliberately *not* shipped:
  ~46 kB gzipped against 1.9 kB for the 32px PNG a tab actually uses, and the rasterised
  versions are indistinguishable at every size a browser asks for. Its viewBox is already
  square and tight to the *painted* bounds — measured by rasterising and finding the alpha
  box, because `getBBox()` ignores stroke width and would clip the brain outline. Note
  that `drawImage(img, 0, 0, w, h)` stretches rather than fitting, which is why the
  viewBox has to be square before rendering.
- **`index.html` opens on a start page, not the app.** `#startPage` is a fixed-position
  section over `#app`, hidden by `#enterAppButton` — the same shape calmar uses. The app
  is behind it the whole time, so the canvas is already sized and nothing needs
  re-laying out. Every e2e test dismisses it in `beforeEach`.
- **Loads are serialised through `enqueueLoad`.** A file input fires `change` when the
  files are set, not when the async handler finishes, so two quick picks — or a pick
  during a drop — started overlapping `loadSurface` calls that interleaved on
  `state.surfaces` and the active-surface mirrors.
- **`setInputFiles` does not wait for the load.** In e2e, always follow it with a wait on
  the status text or the surface-list count before touching `window.__surfannotate`.
  Getting this wrong shows up as a rare `session is null`, one test per full run.
- **`state.surfaces` is the list; `state.mesh`/`geometry`/`session`/... are mirrors of
  whichever entry is active,** written by `activateSurface`. The exceptions are
  deliberate: `state.graph`/`finder`/`excluded` belong to **`bindSession`**, because
  they track the *cut* graph rather than the surface's own, and the overlay mirrors
  belong to the overlay handlers. Assigning `entry.graph` in `activateSurface` puts the
  uncut graph back over bindSession's work and forces a second full rebuild.
- **Every guard in `fill.js` is a fraction of the WALKABLE surface, not `graph.V`.**
  `excludeVertices` keeps a completed ROI's vertices and their indices and only strips
  their edges, so `graph.V` stops being the size of the surface a flood can reach the
  moment any ROI is saved. Measured against it, the >half-the-surface swap fires
  spuriously — handing back the exterior as the ROI, with `error: null` — and the 40%
  escape guard goes blind as the parcellation fills up.
- **Exactly one surface is visible at a time.** Not a UI preference: the depth picker
  returns a position, never an identity, so a click over two overlapping meshes could
  not be attributed to either. Multiple simultaneous surfaces would silently break
  vertex picking.
- **ROI sessions are keyed by topology (`vertexCount:triangleHash`), not by file.** One
  subject's white/pial/inflated share a session so border points survive a switch;
  `RoiSession.rebind` moves it and deliberately discards the *working* region's traced
  chain and fill, which are geometry-dependent — saved ROIs keep theirs, see the
  border note below. Deleting a surface only drops the session once the last surface
  with that topology is gone. `test/fixtures/lh.flat.inflated.surf.gii` is the flat
  patch's topology under a warped geometry, for testing exactly this.
- **The edge-closure button is named after the edge that actually exists.**
  `EDGE_LABELS` in `main.js` picks between "Close on surface edge", "Close on ROI
  edge" and "Close on edge" from `state.edgeSources`, which `bindSession` sets from
  the two halves it already has (`entry.openEdge` and the exclusion mask). This is
  not cosmetic: a hemisphere has no visible edge, so a fixed "surface edge" label
  read as inapplicable at exactly the moment closing against a finished ROI was the
  right tool, and the whole abutment workflow went unfound. The refusal in
  `onCanvasClick` leads with the same phrase for the same reason — reaching into a
  finished ROI is nearly always an attempt to share its border.
- **"Use a completed ROI as an edge" is one graph operation, not a special case.**
  `exclude.js` isolates the ROI's vertices, which makes its rim an open edge; every
  other layer — pathfinder, fill, `closeOnEdge` — then behaves as it already did for a
  flat patch. Vertices keep their indices (labels and clicks refer to them), and
  `isIsolated` is what keeps them out of paths and fills. Resist adding a barrier
  parameter to the algorithms: the graph is the barrier.
- **An ROI is a definition, not a mask.** `state.rois` holds border points, closure
  mode, region index and an anchor; `mask`/`chain`/`error` on them are *outputs* of
  `recomputeParcellation` and are overwritten wholesale. Never edit a mask in place —
  the next recompute discards it.
- **Order is meaning.** Each ROI is resolved with the ROIs above it cut away, so
  earlier ROIs win every overlap and editing one re-derives all the ones below it.
  This is what makes a moved shared boundary move both sides.
- **`restoreEdited` clears the session too.** The ROI is authoritative again once it
  is back on the list, and a leftover copy of its clicks means a later Save appends it
  a second time under a new id and colour — the duplicate then resolves as
  unresolvable, because the original already owns the territory.
- **Reopening keeps the ROI's position** (`state.editIndex`). That is what makes it
  work at all: an ROI's border points routinely lie *inside* the ROI drawn next to it,
  because the fill excludes the border row, so V2 claims the row V1 was clicked along.
  Editing V1 in place means only the ROIs above it constrain, and V2 is below.
- **The anchor is how an ROI is recognised after its neighbours move.** Component size
  ordering alone flips as ROIs grow and shrink; `anchorVertex` picks the vertex furthest
  from the border by hop count, which is the last one a neighbour would take. The border is recomputed
  from the clicks, not restored from the saved chain, for the same reason the clicks are
  authoritative everywhere else.
- **The clicked vertices are the authoritative ROI state for *editing*; the saved
  border is authoritative for *resolving*.** `saveRoi` stores both: `clicks`, and
  `border` — the chain as traced on the surface it was drawn on. `resolveRoi` adopts
  the border verbatim (`RoiSession.adoptChain`) and only re-traces from the clicks
  when the border is no longer walkable, i.e. an ROI above has cut through it. This
  is what makes an ROI the same vertices on lh.sphere.reg, lh.inflated and lh.white:
  the fill is topological, so the same barrier and anchor give the same region on all
  three, whereas a shortest path between two clicks runs differently on each — on a
  folded surface a border traced on the sphere leaked and the ROI resolved as
  `FILL_ESCAPED`, which is the bug this fixed. Reopening still re-traces on the
  surface shown, so the clicks remain the thing you edit. The mask is always derived
  and discarded whenever clicks or border change. freeview does the opposite and
  that is what makes its undo impossible.
- **Flood fill must only ever walk the 1-ring graph.** Augmenting it (unfolded 2-ring
  edges, k-ring neighbourhoods) adds edges that cross faces, so the fill hops the
  barrier and swallows the hemisphere. Validate the chain before filling.
- **Exports must undo the loader's translation.** NiiVue adds the volume centre
  to every vertex on load — `cras` from a FreeSurfer footer, `VolGeomC_R/A/S` from
  GIfTI — turning tkreg RAS into scanner RAS so meshes line up with volumes. A
  `.label` header declares `vox2ras=TkReg` and FreeSurfer's
  `labelGetSurfaceRasCoords` takes it verbatim, so the shift has to come back off:
  `io/geometryOffset.js` recomputes it from the same bytes and the writers subtract
  it. It mirrors NiiVue's quirks deliberately — `cras` is applied even when the
  footer says `valid = 0`, and GIfTI values are read only from CDATA — because a
  correction that does not match what was applied is worse than none.
  `showCoordinateSource` distinguishes the two cases, because the advice differs: an
  inflated or spherical surface shares the native vertex indexing, so switching to a
  loaded `lh.white` carries the ROIs over; a flat patch is a *cut* with its own
  numbering and fewer vertices, so sending the user to a whole hemisphere would hide
  their work rather than fix anything.
  Drawing on `lh.inflated` or a flat patch still writes *that* surface's coordinates
  — freeview substitutes the white surface (`SurfaceLabel.cpp:408`), this app warns
  instead. `showCoordinateSource` names the surface in the export panel and flags a
  non-anatomical one, using `naming.surfaceKind` plus a planarity check on the
  geometry, which catches a flat patch whatever it is called. Substituting a
  same-topology anatomical surface automatically is still open.
- **`.annot` labels are colours, not indices.** FreeSurfer stores each vertex's
  annotation as its label's colour packed `r + (g << 8) + (b << 16)` and recovers
  the label by matching that against the colour table. So two labels with one
  colour are one label, and pure black is "unlabelled". The palette has sixteen
  colours and a parcellation can have more: `uniqueAnnotColors` nudges
  collisions one unit apart and the writer refuses to write a table that would
  merge. Names are null-terminated and every integer is big-endian; verified
  against nibabel's `read_annot` (labels, names and colours all round-trip).
  The whole-parcellation exports write `savedRois()` only — an ROI that is
  reopened for editing is off the list until saved, and the status says so.
- **Single-ROI exports write the selected saved ROI, and saving selects it.**
  The region being drawn is not exportable: it can still change, and a file
  of it is a snapshot nothing refers back to. Saving used to leave the ROI
  *unselected* because the export file name came from the ROI-name field,
  which goes on naming the next ROI, so an auto-selected ROI got exported
  under the next name. `exportStem` now takes the name from the selected ROI
  itself (`requireSavedRoi`), which is what makes selecting on save safe.
  While any ROI is reopened, every export is disabled (`refuseWhileEditing`).
- **A session is definitions, never masks, and it rides inside `.label.gii`.**
  `io/session.js` writes what `state.rois` holds — clicks, closure, region
  index, boundary flag, anchor, colour, order — and the landmarks; masks, chains
  and errors are derived and are deliberately not written. The same JSON is
  embedded as a GIfTI MetaData entry (`SurfAnnotateSession`) in both
  `.label.gii` exports, because that is the file people hand to other tools
  and it costs nothing; `.label` (one header line) and `.annot` (a colour-table
  filename string) have nowhere safe to put it. `sessionFromGiftiMetadata` is
  a pattern match, not an XML parse, because DOMParser is absent under
  `node --test` and the entry has exactly one shape. Loading refuses a vertex
  count or triangle hash that differs from the active surface — every number
  in the file is a vertex index. Imported ROIs keep the file's `colorIndex` so
  a parcellation looks as it did; `nextColorIndex` already skips colours in
  use, so ROIs drawn afterwards differ.
- **Importing masks from other tools and recovering border points from them is
  planned, not done.** The agreed design, the decisions already taken with the
  user, the failure cases and the test plan are in `docs/roi-import-plan.md`.
  Read it before starting that work; do not re-derive the design.
- **Exports are named `<hemisphere>.<roi>`, never after the source surface.** See
  `io/naming.js`. An ROI drawn on `lh.sphere.reg` is valid on any surface sharing that
  vertex indexing, so `lh.sphere.reg.surf.V1.label` would misrepresent it.
- **Never trust a fill that covers more than 40% of the surface** — that is a gap in
  the boundary, not a large ROI. Refuse and tell the user. The one exception is an
  edge closure (`closure === 'edge'`): there the barrier has already been *proved* to
  separate the graph by counting components, so a leak is not possible and the guard
  would only block a border that legitimately halves a patch.
- **A closed border is not the only way to enclose a region.** On a cut surface the open
  edge is itself an impassable barrier to a 1-ring flood fill, so a border running from
  the cut to the cut encloses a region with no loop at all. That is what `closeOnEdge`
  builds, and it is why flat patches do not need dozens of clicks along the rim.
  It does *not* follow that any edge-to-edge line separates the surface — one joining
  two distinct cuts turns an annulus into a disk without dividing it — so the component
  count is checked, never assumed.
- **The retinotopy maps carry a display window; the other colour maps do not.**
  They are `RYGBP_eccentricity`, `RYBC_eccentricity`, `YBGR_polar-angle` (DL),
  `RYGBP_polar-angle` and `RYBC_polar-angle`,
  and each is named for the colour sequence it runs through, because several
  conventions are in use and a bare "polar angle" said nothing about which one
  you were looking at. **The name is the sequence, so the first letter is the
  colour at 0** — on a polar-angle wheel that is the right horizontal
  meridian, on an eccentricity map the fovea. The same sequence can sit under
  two keys with two roles (`RYBC` does); the polar-angle version repeats its
  first colour at the full turn and the eccentricity version does not.
- **The hemisphere flip is one checkbox and a key suffix, not more picker
  entries.** A NiiVue layer is coloured by colormap key and nothing else, so a
  mirrored map has to be *registered* — `EXTRA_COLORMAPS` holds every
  polar-angle map twice, the twin under `<key>-flipped`, derived by
  `mirrorPolarAngle` and never transcribed. But the picker lists only the base
  maps: `#overlayFlip` composes the key (`colormapKey`) and
  `syncOverlayControls` splits the layer's key back into picker + box
  (`baseColormap`, `isFlipped`). Every read of the picker in `main.js` goes
  through `selectedColormapKey()`; reading `ui.overlayColormap.value` directly
  is the bug that renders the unflipped map while the box says flipped. The box
  is enabled only for a polar-angle map (`canFlip`) and keeps its state while
  disabled, so a flip survives a detour through eccentricity. Flipping does not
  re-snap the window — the mirrored map spans the same turn, and a typed window
  should not be overwritten by a colour change. The mirror itself: the colour
  at θ is the original's at π − θ, i.e. LUT index j ← (128 − j) mod 256, and
  this is the *only* place a mirror belongs. The wheel
  in `colorLegend.js` samples the LUT by azimuth and must stay as it is —
  mirroring the wheel instead of the map would show the right colours on the
  legend and the wrong ones on the surface. Two traps in the mirror itself:
  NiiVue's `makeLut` divides by the segment length, so two stops on one index
  paint that entry black (stops are keyed by index for that reason), and the
  ends at 0 and 255 are not control points of the original, so they are
  sampled from it (`sampleControlPoints`, which interpolates the way NiiVue
  does). A nearly cyclic map keeps its seam, moved to the left meridian. A polar-angle map is cyclic — it ends
  on the colour it starts on, because 0 and 2π are the same direction — so
  under the default 2nd–98th percentile window the wrap falls inside the data
  and two angles a quarter-turn apart render identically: a plausible picture
  that is simply wrong, which is worse than an ugly one. Eccentricity must
  start at zero or two subjects are not comparable. `colormapWindow` in
  `niivue/colormaps.js` owns the rule and is pure, so it unit-tests with the
  rest. **The rule and the legend are keyed on `colormapRole(key)`, not on the
  key**, so a new polar-angle palette is one entry in `COLORMAP_ROLES` and
  nothing else. `RYGBP_polar-angle` shares its control points with
  `gist_rainbow` on purpose: the *colours* are the same, the role is what
  differs, and under the plain `gist_rainbow` key those colours still get a bar
  and no window. It is only nearly cyclic (matplotlib's ends are a red and a
  magenta), which leaves a faint seam on the right horizontal meridian; that
  is the map as the field knows it and is not to be "fixed". The unit is read off the data rather than
  configured — an angle map in degrees never peaks below 7 and one in radians
  never above 2π — and values fitting neither convention return null rather than
  get a turn invented for them. `state.overlayAutoRange` is never overwritten, so
  **Auto** is the way back. Do not fold this into `applyOverlayDisplay`: the
  opacity slider shares that handler and fires per frame of a drag, which would
  re-snap a window the user had typed over.
- **The overlay mask lives in the layer's *values*, because NiiVue mesh layers
  have no per-vertex alpha.** `blendColormap` drops a vertex on one test —
  `if (v < mnCal) continue`, where `mnCal` is `cal_min` or `-Infinity` — so the
  value is the alpha channel. Hence `MASKED_OUT = -Infinity` (NaN fails the test,
  survives as NaN through every step, and reads off the end of the LUT as black),
  hence `overlay.baseValues` holding the only untouched copy of the file, and
  hence the clamp in `maskedValues`: masking needs `isTransparentBelowCalMin` on,
  which would otherwise *also* drop everything under the 2nd percentile and
  punch scattered holes through the overlay. Anything that moves the display
  window must go through `commitOverlay`, not `commitLayer`, or the old clamp is
  what renders.
- **A shared overlay is one overlay on several meshes, tied by `groupId`.** NiiVue
  layers belong to a mesh, so `shareOverlay` builds a copy per matching surface
  (`cloneOverlayTo`, from the source's `baseValues` and window), and a matching
  surface loaded later receives the copies in `loadSurface`. Display changes are
  made on one surface at a time and carried across at the *switch*
  (`syncSharedOverlays` in `activateSurface`: colour map, window, opacity,
  visibility, mask exemption, active overlay) — one place, rather than every
  handler knowing about siblings. Removal removes the group. The mask was already
  per topology (`state.masks` by `topologyKey`); overlays follow the same
  idea only when `#overlayShare` is ticked — off by default, at the user's request,
  so the one-surface behaviour is what a new session gets.
- **Exempt overlays are restacked to the bottom, and that is what makes the mask
  useful.** `restackLayers` orders exempt overlays before masked overlays, then
  `meshAdapter.replaceLayerStack` puts those layers below the ROI layer. A
  curvature overlay loaded *after* a retinotopy map would otherwise sit over the
  holes the mask opens, and the feature would look broken rather than absent.
  `entry.overlays` is reordered to match so the panel list reads in render order.
- **A dropped mask is recognised by its name, and only on the drop path.** A mask is
  the same per-vertex formats as any overlay — curv, `.label`, `.mgz`, GIfTI — so no
  magic number separates "where is there data" from the data itself, and
  `classifyFile` promotes to `MASK` on the name alone. Substring `/mask/i`, because
  BIDS writes `desc-brainmask` as one word, minus `/masked/i`, because
  `lh.thickness.masked.gii` is an overlay that has *had* a mask applied. The promotion
  never overrides `SURFACE`: geometry named "mask" is still geometry. `#overlayInput`
  deliberately does not infer — picking the overlay button is an explicit statement,
  and it stays the way to look at a mask as data.
- **A mask must never be read through `NVMeshLoaders.readLayer`.** `readCURV` does
  `f32[i] = 1 - (f32[i] - mn) * scale` — min-max normalise *and invert* — and
  `readLayer` reaches it by sniffing the magic bytes, not the filename, so
  `lh.V1.mask` gets it as surely as `lh.curv` does. A binary mask through that
  path keeps precisely the vertices it was meant to exclude, and looks entirely
  plausible doing it. `io/freesurferCurv.js` parses those files honestly; the
  e2e test asserts the vertex count, which is what catches a regression here.
  The inversion is harmless for curvature itself, which is only ever shading.
- **An all-zero mask is valid.** It hides every non-exempt overlay. Keep it in
  `state.masks` so **Clear** can restore the overlays.
- **The polar-angle wheel runs counter-clockwise from the right horizontal
  meridian, and `paintLegend`'s `atan2(-y, x)` is what makes it.** Canvas y points
  down, so dropping the minus mirrors the wheel — which does not look broken, it
  looks like a legend, while silently swapping the upper and lower visual field.
  The convention is not a preference: dorsal V2 represents the lower field and
  ventral V2 the upper, and in the data this was checked against V2d sits near
  4.5 rad and V2v near 1.9 rad, which only lands in the right quadrants when the
  angle is measured the standard way. Clockwise-from-east, clockwise-from-UVM and
  CCW-from-UVM all put V2v at ~0.8 or ~5.5 instead. Pinned by a unit test that
  reads the four compass pixels. Note that
  `Vorlagen/colorbars/color_circle_pol_python_notext.svg`, the figure this was
  built from, is mirrored relative to this — a `ColorbarBase`-on-polar-axes
  quirk. Matching that file would be the bug.
- **The legend's colours come from `colormaps.sampledColormap`, never from
  `EXTRA_COLORMAPS`.** The wrapper returns the 256 entries that NiiVue gives the
  shader and keeps the NiiVue call inside `niivue/`. A legend built from it
  cannot describe one scale while the surface renders
  another — and NiiVue's own maps get a legend without being re-implemented.
  `colorLegend.js` therefore takes the LUT as an argument and stays pure, which
  is what lets the wheel geometry be unit-tested at all.
- **Border points and landmarks are screen-space markers, not vertex labels.**
  They were `markVertexAndRing` — the clicked vertex plus its whole 1-ring, painted
  into the ROI layer — and all three problems with that are properties of vertex
  colour rather than bugs. A layer value is interpolated across the triangle, so the
  marker could only ever be a soft blob; its size came from the mesh, not the screen;
  and a 1-ring is genuinely wider than the vertex it marks, which is the *only*
  reason markers used to be hidden once a region was filled — they overstated its
  extent. `niivue/markers.js` projects them onto `#markerOverlay` instead, so that
  hack is gone and the clicks stay visible over a filled region. The traced chain
  stays a mesh label deliberately: it is a path over the surface and should follow
  the folds. Note `markers.js` rasterises to a pixel buffer rather than stroking a
  path, for the same reason `colorLegend.js` does — that is what makes it testable
  under plain `node --test`.
- **Contrast comes from the halo, never from sampling what is underneath.** Every
  marker is a core inside a rim of the opposite colour, so it reads against dark
  curvature, a bright overlay and a saved ROI's fill without being told which it is
  on. Reading the rendered pixel would have to happen again on every rotation —
  changing the marker colour under the user mid-drag, and costing a full-canvas
  read per frame to do it. The colour select therefore picks taste, not legibility,
  and border points and landmarks are told apart by *shape*: colour is already
  carrying contrast and cannot also carry identity.
- **Markers are culled by normal, and only on a closed surface.** `surfaceOrientation`
  measures which way the normals point by sampling the six axis-extreme vertices,
  where the outward direction is known whatever the mesh. It does *not* infer the
  sign from the winding, and the reason is the whole story of this feature's one
  shipped bug: the first version used signed volume — a correct fact about the
  winding — against normals built under the opposite cross-product convention, and
  the two sign errors it then had (that one, and the eye-space z above) were each
  invisible on their own. Culling is skipped entirely on a cut surface: no far side
  to hide a marker on, and the extreme-vertex argument needs a closed blob anyway.
- **Test marker visibility through a real click, never by hunting for a view that
  shows something.** The e2e test that shipped the inverted cull searched azimuths
  for one that painted any pixel, which an inverted facing test satisfies just as
  well by picking the opposite side — it passed against a build where clicking drew
  nothing at all. A press on the canvas goes through the depth picker, which returns
  the front-most vertex *by construction*, so the marker must appear and must land
  within a few pixels of the pointer. Both halves are needed: "something is painted"
  alone was what the broken version satisfied.
- **A normal test is not a depth test, and that is the deliberate trade.** A marker
  in a sulcus whose normal faces the camera is drawn even when a gyrus is in front
  of it, where the old vertex labels were properly occluded by the geometry. Read
  the other way round, that is the point: a click down a fold used to be invisible,
  and an invisible marker is worse than one showing through a crown you can rotate
  away. Note this is also why the traced chain and the fill can be nowhere to be
  seen on a folded surface while every marker shows — they are labels on the
  surface and the folds hide them. Nothing is wrong when that happens; check on
  `lh.inflated`. A true depth test would mean reading the depth buffer every frame.
- **`--nd-brand-selection` is a surface, never a text colour.** `styles.css`
  declares it as near-black ink in `:root`, but the shared `app-theme.css`
  remaps it per theme — pale green (#e7f0df) in light mode, dark green in dark
  mode — so every `color: var(--nd-brand-selection)` rendered at 1.1:1 on the
  light theme: labels, checkbox captions, ROI names, panel buttons, upload
  captions, the instruction note. Body text is `--nd-brand-text`
  (#18201b light / #e8f5d0 dark); text on the green hover surface is
  `--nd-brand-menu`, which is dark in both themes; and `--nd-brand-white` is
  a *surface* too (#161a0e in dark mode), so text that must be white on the
  export-target row is literal `#fff`. The contrast probe that found this is
  the way to check: compute every text node's WCAG ratio against its effective
  background in *both* themes, because the dark theme also overrides colours
  element by element and hides a bad token.
- **Row highlights in the lists must be anchored on `#controls`.** The shared
  `app-theme.css` (generated by `scripts/lib/app-theme-dist.mjs`) restyles every
  `.layer-list li` in dark mode from a `:root[data-neurodesk-app]
  [data-neurodesk-theme="dark"]:not(...) :is(...)` selector, whose specificity
  beats any class chain an app can write. `.layer-list li.export-target`
  therefore lost its background in the dark theme and only its box-shadow
  survived — which looked like a design choice. The id wins over attributes,
  so the export-target rules carry it. The light theme has the mirror trap:
  it gives buttons a pale face, so glyphs inside a solid row need
  `background: transparent` set explicitly or they vanish white-on-white.
  Check both themes with a screenshot; the e2e suite runs in whichever the
  page defaults to. The same theme rule (`… #controls button`, specificity
  1,4,1) silently disabled *every* button hover in dark mode, because
  `#controls button:hover` is only 1,2,1; the dark hover is therefore written
  once more with one attribute more than the theme uses. Any new interactive
  state on a panel button needs the same treatment or it will only work in
  light mode — measure with `page.hover` and `getComputedStyle`, not by eye.
- **`#controls` must stay `flex-wrap: nowrap`.** The shared `.nd-imaging-controls` class
  sits on the same element and sets `flex-wrap: wrap` for its own row layout. With the
  column direction `styles.css` applies, anything taller than the panel wraps into a
  second column to the *right* of a 320px panel — invisible and unreachable, and silent,
  because wrapping absorbs the overflow so `overflow-y` never scrolls. Growing the tool
  section by ~120px made every annotation button vanish the moment a cut surface was
  loaded. Covered by an e2e test that asserts one column.
- **Toggling `[hidden]` needs `display: none !important`** (in `styles.css`). Any author
  `display` rule outranks the UA stylesheet's `[hidden]`, so an element with both stays
  stubbornly visible. This shipped once as a drop hint permanently covering the canvas.

## NiiVue 0.69 traps, all found the hard way

- `NVMesh.loadLayer` is **static**; calling it on an instance throws silently. Use
  `NVMeshLoaders.readLayer(...)` and push the result onto `mesh.layers`.
- Overlays default to the **full data range**, and `readCURV` min-max normalises *and
  inverts* FreeSurfer curvature. Values cluster mid-range, so a 0–1 window renders flat
  grey and looks like a failed load. We set a 2nd–98th percentile window.
- **There is no vertex picking.** `onLocationChange` gives mm only; the picking shader
  packs depth, not identity. `indexNearestXYZmm` is a ~3 ms linear scan — 163x slower
  than the uniform grid in `vertexLookup.js`.
- **There is no "the ray missed" signal.** `depthPicker` early-returns and leaves the
  crosshair untouched, so an unchanged crosshair is ambiguous. `pickWorldMm` disambiguates
  on screen position.
- **`dragAndDropEnabled: false` is not enough.** `dropListener` calls
  `stopPropagation()`/`preventDefault()` *before* consulting that flag, so drop handlers
  must be **capture-phase** on an ancestor to see the event at all.
- `opts.loadingText` defaults to `"loading ..."` and is painted over an empty canvas.
- Geometry is `mesh.pts` / `mesh.tris`. **`mesh.vertexCount` is `pts.length`**, i.e.
  three times the vertex count.
- Avoid the `Uint8Array` packed-RGBA layer path — it renders nothing in 0.69.0. Use
  `Float32Array` values plus `colormapLabel`.
- **A hand-built mesh layer must set `nFrame4D: 1`.** `NVMeshLayerDefaults` leaves it 0,
  and NiiVue computes the frame as `min(max(frame4D, 0), nFrame4D - 1)` — which is -1, so
  it reads `values[j - vertexCount]`, gets `undefined`, and every colour lookup lands on
  NaN. The whole surface renders black, not the layer.
- **`readLayer` has no case for a FreeSurfer `.label`.** The extension falls through to
  its curvature reader, which cannot parse ASCII and returns a layer with zero values.
  `io/freesurferLabel.labelToValues` expands it and `attachValueLayer` builds the layer.
- `mesh.updateMesh(gl)` costs ~24 ms on a 163k-vertex mesh because it regenerates
  normals for unchanged geometry. Fine per interaction, too slow per frame.
- **`NVMeshUtilities.generateNormals` returns `(p3-p1) × (p2-p1)`** — the negation of
  the usual convention. Never pair it with a sign inferred from triangle winding;
  measure the array you are actually going to use. `surfaceOrientation` does.
- **In `calculateMvpMatrix`'s eye space the viewer is on the -z side**, so an outward
  normal facing you has a *negative* z. NiiVue builds the projection with
  `mat4.ortho(..., near = scale * 8, far = scale * 0.01)` — near greater than far —
  and gl-matrix's `out[10] = 2 / (near - far)` therefore comes out positive where a
  conventional ortho makes it negative, inverting the depth mapping. Measured, not
  derived: the depth picker returns the front-most vertex, whose outward normal
  transforms to z = -0.52.

## Test surface

| Command | Covers |
| --- | --- |
| `pnpm --filter surfannotate test` | `surface/` and `io/` — adjacency, A*, chain validation, fill (including escape and figure-eight cases), vertex lookup vs brute force, ROI session contract, every file writer; plus the pure `niivue/` modules — colour legend, overlay mask, marker projection and rasterisation |
| `pnpm --filter surfannotate lint` | `node --check` over every JS file |
| `pnpm --filter surfannotate test:e2e` | Real Chromium with SwiftShader: shell mount, WebGL2, surface load and index, picking, draw→close→fill→export, drag-and-drop, click-vs-drag, overlay window, marker overlay and back-face culling, colour map and range, ROI naming, edge closure on a flat patch and against a finished ROI |

`test/fixtures/lh.flat.surf.gii` is a synthetic flat patch — a disk with one open edge,
like `mris_flatten` output but a few kB. Regenerate with
`node test/fixtures/make-flat-patch.mjs`. Its faces are wound to point along -x on
purpose: a sheet is one-sided, NiiVue does not cull back faces but does shade them by
the flipped normal, so from the wrong side the patch renders near-black on a dark
background and looks like a failed load. -x is where the default render view looks from.

**When adding an e2e test, verify it fails without the fix.** Two drag-and-drop tests
here passed against broken code — one dispatched events on the wrong element, and the
other used a synthetic `DragEvent` whose `clientX/Y` of 0 made NiiVue's `eventInBounds`
bail before the `stopPropagation` that caused the bug.
