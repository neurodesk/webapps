---
---

Expose a `data-window-commits` counter on the ZARRo canvas. A committed window usually repeats the one already displayed, so the existing `data-window-min` and `data-window-max` attributes cannot tell a browser test that the redraw behind an unawaited `setVolume()` has landed. The counter gives the smoke test a signal that always changes.
