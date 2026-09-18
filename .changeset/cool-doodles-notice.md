---
---

Retry transient Windows sharing violations when cleaning up verified SynthSR release packages. Bound retries to 3.1 seconds and continue to fail on persistent locks, other permission errors, and inference failures.
