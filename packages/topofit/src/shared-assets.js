// Each model is loaded and verified once and handed to every hemisphere. Earlier
// requesters get copies so a buffer can be transferred to a worker without detaching
// another's; the last requester gets the original and the cache lets it go, so consumed
// models do not stay resident for the rest of the run.
export function shareAssets(loadAsset, consumers = 2) {
  const loads = new Map();
  return async (name, from, to) => {
    let entry = loads.get(name);
    if (!entry) {
      entry = { bytes: loadAsset(name, from, to), remaining: consumers };
      loads.set(name, entry);
    }
    entry.remaining -= 1;
    const last = entry.remaining === 0;
    if (last) loads.delete(name);
    const bytes = await entry.bytes;
    return last ? bytes : bytes.slice(0);
  };
}
