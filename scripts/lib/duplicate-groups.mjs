/**
 * Rank groups of identical files by the bytes their extra copies cost.
 *
 * `files` are `{ path, hash, size }`; `declaredPaths` holds the copies a
 * declared app-scoped runtime family keeps on purpose, which the budget does
 * not count. A group's `wastedBytes` is what is left after those.
 */
export function rankDuplicateGroups(files, { declaredPaths = new Set(), limit = 15 } = {}) {
  const groups = new Map();
  for (const file of files) {
    const group = groups.get(file.hash) ?? { sha256: file.hash, size: file.size, paths: [], declaredBytes: 0 };
    group.paths.push(file.path);
    if (declaredPaths.has(file.path)) group.declaredBytes += file.size;
    groups.set(file.hash, group);
  }
  return [...groups.values()]
    .map(({ declaredBytes, ...group }) => ({
      wastedBytes: Math.max(0, group.size * (group.paths.length - 1) - declaredBytes),
      copies: group.paths.length,
      ...group,
      paths: group.paths.sort(),
    }))
    .filter(group => group.wastedBytes > 0)
    .sort((a, b) => b.wastedBytes - a.wastedBytes || a.paths[0].localeCompare(b.paths[0]))
    .slice(0, limit);
}
