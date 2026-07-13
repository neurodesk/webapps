# UI Task Contract Validation

Manual browser checks:

- The task selector lists the SCT stable `sct_deepseg` task inventory.
- Unvalidated tasks are visible but the Run action remains disabled.
- Unsupported and retired tasks show a reason.
- Asset failures preserve loaded image state.
- The interface contains no obsolete model terminology.

Current status: validated by code review, manifest validation, lint, and served
asset checks. Full run-through remains open until implementation reaches
runnable model support.
