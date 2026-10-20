/** Serializes rendering and restores the last committed immutable snapshot on failure or cancellation. */
export function createPreviewQueue({ ready, render }) {
  let committed = null;
  let tail = Promise.resolve();

  return async function show(next, { signal } = {}) {
    const pending = tail.then(async () => {
      signal?.throwIfAborted();
      await ready;
      signal?.throwIfAborted();
      const previous = committed;
      try {
        await render(next);
        signal?.throwIfAborted();
        committed = next;
      } catch (error) {
        // Native loads finish after abort; restoration must settle before another request starts.
        try {
          await render(previous);
        } catch (restoreError) {
          const errors = [error, restoreError];
          if (previous) {
            try {
              await render(null);
              committed = null;
            } catch (clearError) {
              errors.push(clearError);
            }
          }
          throw new AggregateError(errors, 'Could not restore the previous image.');
        }
        throw error;
      }
    });
    tail = pending.catch(() => {});
    return pending;
  };
}

/** NiiVue adapter for a single file and an optional copied scalar-map window. */
export function createNiivueVolumePreview({ viewer, ready, emptyState }) {
  async function render(preview) {
    if (preview) {
      const window = preview.range ? { calMin: preview.range[0], calMax: preview.range[1] } : {};
      await viewer.loadVolumes([{ url: preview.file, name: preview.file.name, colormap: 'gray', ...window }]);
    } else {
      await viewer.removeAllVolumes();
    }
    emptyState.hidden = Boolean(preview);
  }

  const show = createPreviewQueue({ ready, render });
  return (preview, options) => show({ file: preview.file, range: preview.range && [...preview.range] }, options);
}
