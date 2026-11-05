// Keeps the viewer in step with what the page committed when an operation is cancelled.

/**
 * Shows `view` with `show` (a createPreviewQueue). If `signal` aborts after the view is shown,
 * before the caller can commit it, shows `previous` again (null clears the viewer) and throws
 * the abort, so a cancelled load or run never leaves its image on screen.
 */
export async function showCommitted(show, view, previous, signal) {
  await show(view, { signal });
  if (!signal.aborted) return;
  await show(previous);
  signal.throwIfAborted();
}
