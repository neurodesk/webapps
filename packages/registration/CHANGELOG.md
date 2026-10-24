# @neurodesk/registration

## 0.1.2

### Patch Changes

- Restore the WebAssembly stack after each kernel call so repeated corrections and transform applications do not exhaust the stack. Export the stack functions from the pinned builds and verify 200 runs on one instance.

## 0.1.1

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
