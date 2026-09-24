---
"zarro": patch
---

Run ZARRo on the published `@niivue/niivue@1.0.0-rc.14` and drop the local NiiVue patch. Measurements, crosshair panning, cancellable reads, field-of-view focus, plan-swap waits and streamed volume geometry now use NiiVue's own APIs. Right-clicking a measurement now also emits NiiVue's `measurementRemoved` event. The vertical equal-slices layout uses NiiVue's own equal-size column layout, which keeps all three planes at one scale.
