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

/**
 * NiiVue adapter for one file with an optional copied scalar-map window, and an optional signed
 * overlay on it (a field map on its image: warm above range[0], winter below -range[0]).
 * `null` clears the viewer.
 */
export function createNiivueVolumePreview({ viewer, ready, emptyState }) {
  async function render(preview) {
    if (preview) {
      const window = preview.range ? { calMin: preview.range[0], calMax: preview.range[1] } : {};
      const volumes = [{ url: preview.file, name: preview.file.name, colormap: 'gray', ...window }];
      const overlay = preview.overlay;
      if (overlay) {
        const range = overlay.range ? { calMin: overlay.range[0], calMax: overlay.range[1], calMinNeg: -overlay.range[1], calMaxNeg: -overlay.range[0] } : {};
        volumes.push({ url: overlay.file, name: overlay.file.name, colormap: 'warm', colormapNegative: 'winter', opacity: 0.6, ...range });
      }
      await viewer.loadVolumes(volumes);
    } else {
      await viewer.removeAllVolumes();
    }
    emptyState.hidden = Boolean(preview);
  }

  const show = createPreviewQueue({ ready, render });
  const copy = (preview) => ({ file: preview.file, range: preview.range && [...preview.range] });
  return (preview, options) => show(preview ? { ...copy(preview), overlay: preview.overlay && copy(preview.overlay) } : null, options);
}
