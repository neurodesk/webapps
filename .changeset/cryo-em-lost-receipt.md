---
"cryo-em": patch
---

Cryo-EM follows a step the server accepted even when the response to Run was lost on the way back: after a failed submission the page re-reads the project and follows the job it finds running.
