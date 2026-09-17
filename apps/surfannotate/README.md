# SurfAnnotate

Cortical surface viewer with manual ROI delineation and vertex selection. Everything
runs in the browser — no surface, overlay or label ever leaves your machine.

## What it does

**Visualisation.** Load a FreeSurfer surface (`lh.pial`, `lh.white`, `lh.inflated`, …),
a GIfTI `.surf.gii`, `.mz3`, or any other mesh NiiVue reads, then add a per-vertex
overlay: curvature, thickness, `.annot`, `.label.gii`, `.shape.gii`, `.mgz`, or CIFTI
`.dscalar.nii`. Colour map, opacity and display window are adjustable, including
`gist_rainbow`, which NiiVue does not ship.

Five are retinotopy maps, each named for the colour sequence it runs through.
Eccentricity: **`RYGBP_eccentricity`** (matplotlib's `rainbow_r`: red at the
fovea, through yellow, green and blue, to purple at the periphery) and
**`RYBC_eccentricity`** (red at the fovea, yellow, blue, cyan at the periphery).
Polar angle: **`YBGR_polar-angle`** (yellow, blue, green, red, yellow —
contributed by DL), **`RYGBP_polar-angle`** (`gist_rainbow` read as a turn: red,
yellow, green, blue, pink and back to red, the convention many retinotopy
figures use) and **`RYBC_polar-angle`** (red, yellow, blue, cyan at the quarter turns,
back to red). *Flip for the other hemisphere* mirrors whichever polar-angle map
is selected about the vertical meridian, so the colour at angle θ becomes the
original's at π − θ. Show one hemisphere plain and the other flipped and the
two read the same way — upper field up, lower field down, nasal and temporal
swapped as the anatomy is. Each overlay keeps its own flip. Picking any of
them also sets the display window, because for these the window is part of the
map — polar angle is cyclic and only truthful across exactly one turn, and
eccentricity has to start at zero for the fovea to sit at the bottom of the
scale. The turn is read off the data: a maximum at or below 2π is radians,
anything larger is degrees, and negative values take the signed variant.

**Masking.** Load a binary mask — a FreeSurfer `.label`, a curv-format file, a
`.mgz`, a GIfTI, anything with one value per vertex — and every overlay is drawn
only where it is non-zero. Everywhere else the overlay is fully transparent, so
the curvature underneath shows through as if nothing were loaded. An all-zero
mask hides every non-exempt overlay. This is what makes a retinotopy map
readable: polar angle means nothing outside the region it was fitted in.
Curvature is exempt by default when the filename contains a `curv` or
`curvature` token, since it is the anatomy the mask exists to reveal. You can
exempt any overlay with *Always show this overlay*. The mask follows the vertex
indexing, so it carries across a subject's `white`, `pial` and `inflated`.

Masks are parsed rather than handed to NiiVue: its FreeSurfer curv reader
min-max normalises and inverts, which would silently keep exactly the vertices
the file excludes.

The scale is drawn on the view itself, bottom left, so a colour can be read back
as a number without leaving the picture. Eccentricity and polar angle get a
colour wheel — rings at a third, two thirds and the full window for one, the four
quarter turns labelled in the data's own unit for the other — and every other
colour map gets a ticked bar. Polar angle is measured the standard way,
counter-clockwise from the right horizontal meridian, so the upper visual field
is at the top of the wheel. The panel's *Show the colour scale on the view*
hides it.
**Auto** puts the percentile window back.

**Closed ROIs.** Click border points around a region — nothing is traced while you
click, so you can rotate freely. Press *Close ROI* to join the points with shortest
paths along the surface and close the loop, then *Fill region*. Points are joined **in
the order placed**, not by proximity.

**ROIs against the edge of a flat patch.** On a cut surface — an unfolded flat patch,
or any mesh with an open edge — an ROI often runs right up to the cut, so its border
is partly your line and partly the edge of the patch itself. *Close on surface edge*
draws only the part that crosses the patch: both ends of your line are extended to the
nearest edge vertex, and the edge closes the region. Two points are enough. The smaller
of the two sides is filled, and *Other side* swaps.

Nothing is traced *along* the edge, because nothing needs to be. Flood fill walks the
mesh's 1-ring graph and no edge of that graph crosses the cut, so the cut is already an
impassable barrier. A border reaching it at both ends therefore separates the patch on
its own — and that separation is verified by counting connected components, not assumed.
A line running between *two different* cuts (the outer rim and the rim of a hole) does
not separate an annulus, and is refused rather than silently filled.

**Several surfaces and overlays at once.** Load as many surfaces as you like — by
picker or by dropping them on the viewer — and switch between them from the list. One
is shown at a time, because overlapping cortical surfaces occlude each other and a
click over two of them could not be attributed to either. An overlay belongs to the surface it
was loaded onto. Tick *Apply overlays to every loaded surface with the same vertices*
and it is instead applied to every loaded surface of the same subject — `white`,
`pial`, `inflated` and `sphere` — as one overlay: one colour map, range and
visibility, removed from all of them together, and a matching surface loaded later
receives it too. Ticking the box after overlays are loaded shares those as well; if no
other loaded surface has the same vertices, the status line says so.

ROIs follow the *vertex indexing*, not the file. Surfaces sharing one — a subject's
`white`, `pial`, `inflated` and `sphere` — share the ROIs, so you can draw on the sphere
or the inflated surface and see exactly the same vertices on the folded one. A saved ROI
carries its border as a vertex path, and a fill is purely topological, so the region is
identical on every such surface; only when you *reopen* an ROI is the border re-traced
between your clicks on the surface shown, because a shortest path genuinely runs
differently over different geometry. Surfaces with unrelated topology keep separate, independent ROIs.

Dropped files are identified by their magic number and name rather than by drop order,
so a surface and an overlay can be dropped in any sequence. A FreeSurfer `.label` is
expanded here rather than by NiiVue, which has no reader for it: it is a sparse list of
the vertices in a region, so it is scattered into one value per vertex and windowed
above zero, which is what makes a mask show as a region rather than a flat surface.

**ROIs as a parcellation.** Save a filled region and it joins an ordered list of
ROIs. Each ROI is resolved on the surface the ROIs above it have left, so no vertex
belongs to two, and each one's border works like the edge of a flat patch: the next ROI
can be closed against it with only its own outer border clicked. This works on closed
surfaces too — `lh.pial` has no edge to begin with, but once V1 is cut out it is a
sphere with a hole in it.

An ROI is not stored as a mask. It is a *definition* — its border points, how they were
closed, and a vertex deep inside the region — and the masks are derived by resolving the
whole list in order. That is what makes editing work: pull V1's border back and V2 grows
into the space, because V2 was always defined as "my line, and whatever lies between it
and the ROI above me". No unassigned strip is left where the boundary used to be, and
the two never overlap.

Reordering is meaningful, not cosmetic: an ROI can be squeezed out entirely by one
promoted above it, and moving it back up takes those vertices straight back. An ROI
whose border no longer resolves is struck through and claims nothing, rather than being
silently dropped.

The pencil reopens an ROI to adjust its border. It keeps its place in the list, so the
ROIs above it constrain the drawing exactly as when it was first drawn, and the ROIs
below it are re-derived on save. **Exports write saved ROIs only.** Saving selects the
ROI just saved, so the flow is draw, save, export; clicking a name selects another, the
row turns solid green and the export panel names it. The region being drawn is never
written directly. Each row also carries a swatch of the ROI's fill colour.

**Continuing earlier work.** *Load ROIs from a file* in the Saved ROIs panel restores
ROIs from a session file or from a `.label.gii` this app exported, with their border
points intact, so they can be reopened, reordered and built on. Loaded ROIs keep the
colours they were saved with; an ROI already on the list that shares one moves to a free
colour. The palette has sixteen colours, chosen to stay apart from each other and from
the red fill and yellow border of a region still being drawn. While an ROI is reopened
for editing, every export waits until it is saved or the edit discarded: the whole-list
files would lack it, and the single-ROI files would write it half-edited. The file must
belong to the loaded surface — every number in it is a vertex index — and a different
vertex count or triangulation is refused with a message rather than mapped. A label file
from another tool has no border points to restore; recovering them from the mask is the
next step.

**Vertex selection.** Point-and-click landmarks, exported as a vertex list.

A **Cite** button in both headers opens the citations — NiiVue for the rendering and
mesh parsing. Add entries to the `#citationsDialog` section in `index.html`.

The app opens on a short start page — what it reads and writes, and how it works — with
a **Start annotating** button. It is a section over the app rather than a second
document, so there is still one bundle and one path in the composite site.

## Exports

| Format | Use |
| --- | --- |
| FreeSurfer `.label` | The universal FreeSurfer exchange format; opens in freeview. Also FreeSurfer's own control-point format, so it doubles as a landmark file. Can be dropped back in as an overlay. |
| GIfTI `.label.gii` | Opens in Connectome Workbench, FSL, nibabel, NiiVue. Carries the ROI name and colour. Editable metadata also includes preceding ROIs that constrain this ROI, so reimport restores its exact region. |
| Points JSON | Landmarks plus a mesh fingerprint, so a point set cannot be loaded onto the wrong surface. |
| FreeSurfer `.annot` | **Every saved ROI in one file**, in list order, with names and colours. Opens in freeview; `mri_annotation2label` splits it back into `.label`s. |
| GIfTI `.label.gii` (all ROIs) | The same parcellation as one integer per vertex with a label table. Opens in Workbench, nibabel, NiiVue. |
| Session `.surfannotate.json` | **The editable form**: every ROI's border points, closure and anchor, plus the landmarks. Load it back to continue editing or add ROIs. The `.label.gii` exports carry the same block in their metadata, so they reopen here too. |

Coordinates are written in tkreg (surface) RAS, as the `.label` header declares.
NiiVue adds the volume centre on load so meshes align with volumes, and the export
takes it back off — otherwise `mri_label2vol` and `mri_label2label --regmethod
coords` would be silently wrong while anything keyed on the vertex index looked
fine. **The coordinates come from the surface you drew on**, and the export panel says which.
freeview sidesteps this by substituting the white surface when the displayed one is
inflated; this app tells you instead.

On an inflated or spherical surface only the coordinates are affected — the vertex
indexing is the native surface's, so loading `lh.white` or `lh.pial` and switching
brings the ROIs with you, and the panel names the loaded surface to switch to.

A flat patch is different: it is a *cut* of the native surface, so it has a different
number of vertices, and its indices — and the ROIs drawn on it — belong to the patch
alone. Switching to a whole hemisphere shows none of them. They are not lost; ROIs
follow the vertex indexing and reappear when you switch back, which the status line
says when it happens.

A whole-parcellation file is named `<hemisphere>.<parcellation>`, from the *All saved
ROIs as one file* field: `lh.retinotopy.annot`, `lh.retinotopy.label.gii`. An ROI that
did not resolve is left out and named in the status line. Note that `.annot` identifies
a label by its colour, not by an index, so two ROIs sharing a palette colour are nudged
one unit apart on the way out — invisible on screen, distinct in the file.

Files are named `<hemisphere>.<roi>`, e.g. `lh.V1.label` — not after the specific
surface they were drawn on. An ROI traced on `lh.sphere.reg` applies equally to
`lh.white` and `lh.pial`, which share a vertex indexing. The hemisphere comes from
GIfTI's `AnatomicalStructurePrimary` when present, otherwise from the filename
(FreeSurfer `lh.`/`rh.`, BIDS `hemi-L`, or HCP `.L.`); when it cannot be determined
the file is just `<roi>.label`.

CIFTI `.dlabel.nii` is deliberately not supported: it is only meaningful relative to a
specific grayordinate space, which a native-space surface is not. Export `.label.gii`
and run `wb_command -cifti-create-label`, which is what the HCP pipelines do.

## Development

```bash
pnpm --filter surfannotate dev            # vite dev server
pnpm --filter surfannotate test           # node --test, no browser needed
pnpm --filter surfannotate lint           # syntax check
pnpm --filter surfannotate build          # production bundle

pnpm --filter surfannotate test:e2e       # Playwright, headless WebGL2 via SwiftShader
```

`test:e2e` fetches and builds its own fixtures first, so a clean checkout needs no
extra step. `test/fixtures/` is gitignored — the data is far too large to commit — but
every file in it is reproducible: `lh.pial` and `lh.curv` are downloaded from NiiVue's
BSD-2 demo assets by `scripts/fetch-fixtures.mjs`, and the two flat patches are
generated by `test/fixtures/make-flat-patch.mjs` (a synthetic grid) and
`test/fixtures/make-real-patch.mjs` (cut out of `lh.pial`).

## Licence

Live site: <https://webapps.neurodesk.org/surfannotate/>

MIT — see `LICENSE`. A permissive dependency does not dictate the licence of the work
that uses it, so this being MIT while NiiVue is BSD-2-Clause is not a conflict; what
those licences do require is that their notices travel with any redistribution of their
code. The production bundle contains that code with the notices stripped by
minification, so they are reproduced in `THIRD-PARTY.md`.

Uses [NiiVue](https://github.com/niivue/niivue) (BSD-2-Clause) for rendering and mesh
parsing, and `@neurodesk/webapp-components` (MIT) for the shell.
