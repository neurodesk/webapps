const volume = (source) => [{ url: source.displayFile, name: source.displayFile.name }];

export async function loadSlotSource({ viewer, source, previous, signal }) {
  signal?.throwIfAborted();
  try {
    await viewer.loadVolumes(volume(source));
    signal?.throwIfAborted();
  } catch (error) {
    if (previous) await viewer.loadVolumes(volume(previous));
    else await viewer.removeAllVolumes();
    throw error;
  }
  return source;
}
