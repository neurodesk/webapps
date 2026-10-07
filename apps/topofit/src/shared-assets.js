// One verified download per asset name for the lifetime of the returned function. Each
// caller receives its own copy so a buffer can be transferred to a worker without
// invalidating the shared one.
export function shareAssets(loadAsset) {
  const loads = new Map();
  return async (name, from, to) => {
    if (!loads.has(name)) loads.set(name, loadAsset(name, from, to));
    return (await loads.get(name)).slice(0);
  };
}
