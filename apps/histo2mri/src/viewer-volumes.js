// Keep file descriptors for rollback: NiiVue releases old decoded images during loadVolumes.
export async function replaceViewerVolumes(viewer, previous, next, signal) {
  signal?.throwIfAborted();
  const crosshair = [...viewer.crosshairPos];
  try {
    await viewer.loadVolumes(next);
    signal?.throwIfAborted();
  } catch (error) {
    await viewer.loadVolumes(previous);
    viewer.crosshairPos = crosshair;
    throw error;
  }
}
