---
---

Configure Chromium's virtual motion sensor before starting the homepage phone-tilt test so rendering delays cannot trigger the no-sensor fallback before its first sample.
Pause the launch check at the first frame beyond 10 mm and inspect collision telemetry before pausing so browser-driver delays cannot extend the measured flight.
