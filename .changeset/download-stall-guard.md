---
"@neurodesk/webapp-components": patch
---

Fail a download whose headers or next body chunk do not arrive within 30 s, instead of leaving it pending for ever when the host accepts the connection and then goes silent. `fetchModel` and `fetchWithRetry` apply the stall guard to every model and example download; the waits between HTTP 429 retries are not counted, and a user's cancel still reports as a cancel. The example selector reports a stalled download as "The download of <file> stalled (no data for 30 s). Load the example again to retry."
