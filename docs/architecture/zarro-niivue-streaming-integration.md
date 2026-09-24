# Zarro NiiVue streaming integration

## Context

Zarro used to run a patched `@niivue/niivue@1.0.0-rc.11`. The patch edited the
minified bundle to add field-of-view protection, crosshair panning, cancellable
chunk reads, NVSlide coarse-tile fallback, a zoom-aware ruler and square cropped
layouts. Zarro also reached into NiiVue internals for measurements, plan swaps
and streamed volume construction.

[niivue/mono#160](https://github.com/niivue/mono/issues/160) tracked each of
those workarounds upstream. All of them landed on `main` and ship in
`1.0.0-rc.14`, so Zarro now uses the registry package without a patch.

## What NiiVue owns

| Behavior | Upstream API |
| --- | --- |
| Crosshair panning | `DRAG_MODE.crosshairPan` |
| Cancellable volume reads | `ChunkedVolumeFetch.signal` |
| Cancellable slide tile reads | `SlideTileSource.fetchTileBytes(..., signal)` |
| Uniform detail inside the visible field of view | `NVChunkedVolume.setFocus(frac, focusBounds)` |
| Waiting for a plan swap | `NVChunkedVolume.whenRefocusIdle()` |
| NVSlide coarse fallback while finer tiles load | `NVSlide.visibleTiles().fallback` |
| Measurements | `addMeasurement`, `removeMeasurement`, `getMeasurements`, `pickMeasurement`, `clientToCanvas` |
| Streamed volume geometry | `createStreamingNVImage` |
| Ruler under 2D zoom, micrometer steps | built in |

Zarro owns OME-Zarr metadata, the encoded-byte and decoded-native-chunk caches,
translated mosaic composition, stain orchestration and exports.
`ChunkedVolumeSource.fetchChunk` remains the boundary between the two.
`ZarrReadSession` combines the renderer's abort signal with the lifetime of the
current read plan, so either a stale brick or an obsolete plan stops the read.

## Behavior that changed with the upgrade

The multi-LOD planner treats the budget floor as a hard cap. On a
slide-sized pyramid under a 2 GiB budget, the brick under the focus is the
finest level the budget allows rather than level 0. Zarro always passes
`focusBounds`, so the visible field of view stays at one uniform level.

The vertical equal-slices layout is NiiVue's stock column multiplanar layout
with `isEqualSize`. It replaces a custom layout whose square crop came from the
patch. The tile geometry is unchanged, three equal squares, and all three
planes render at one common scale. Each plane is now letterboxed to its own
extent instead of cropped to the shortest one.

The planner loads the coarsest pyramid level as a floor when a volume opens.
Swaps to that level are served without a network read.

## Remaining local code

`cursor_zoom.ts` keeps pointer-anchored wheel zoom. NiiVue's
`wheelZoomAnchor: 'pointer'` applies only inside its own wheel handler, which
uses a fixed zoom step. Zarro's handler honors the Scroll zoom speed setting and
line and page delta modes, and the anchor helpers it would need
(`zoomPan2DAbout`, `screenSlicePick`) are not exported.

`nvslide_measurement.ts` keeps measurement geometry for NVSlide panes. NVSlide
scalar tiles with GPU-side windowing are still open upstream as
[niivue/mono#159](https://github.com/niivue/mono/issues/159).

`waitForStainLayerUploads` polls the public `chunkStreamStats()`.
`chunkStreamIdle` fires only on a busy-to-idle transition, so a wait that starts
while the stream is already idle would never resolve.

## Verification

The Zarro unit suite covers focus planning against the upstream planner,
mosaic cancellation, plane-source signal forwarding, stain swap ordering and
layouts. The Playwright smoke suite covers composite loading, multi-stain level
swaps, layouts, wheel zoom and exports against the production build.
