// Download names derived from a reconstruction's id (its relative path, " (n)" for a repeat).

export const stem = (name) => name.replace(/\.swc$/i, "");

/** A download name for a repaired file: its path with folders joined by "_", unique in the batch. */
export function repairedName(id, taken) {
  const [, path, copy] = id.match(/^(.*?)(?: \((\d+)\))?$/s);
  const base = `${stem(path)}${copy ? `_${copy}` : ""}`.replaceAll("/", "_");
  let name = `${base}_repaired.swc`;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}_repaired.swc`;
  taken.add(name);
  return name;
}
