// SWC reading, validation and repair. Pure: text in, samples and issues out.
//
// An SWC sample is one line: id, type, x, y, z, radius, parent (Cannon et al. 1998).
// Types follow the standard: 1 soma, 2 axon, 3 basal dendrite, 4 apical dendrite;
// anything else is kept and measured under "All" only.

export const SOMA = 1;
export const TYPE_NAMES = Object.freeze({ 1: "soma", 2: "axon", 3: "basal", 4: "apical" });

/** NeuroM's z-jump check (has_no_jumps) flags a step larger than this along z, in µm. */
export const Z_JUMP = 30;

/**
 * @typedef {{ id: number, type: number, x: number, y: number, z: number, r: number, parent: number, line: number }} Sample
 * @typedef {{ code: string, severity: "error" | "warning" | "info", message: string, lines: number[], repaired: boolean }} Issue
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function issue(issues, code, severity, message, lines, repaired) {
  issues.push({ code, severity, message, lines: lines.slice(0, 20), repaired });
}

/** Parse the lines into samples; malformed lines and repeated ids are reported and dropped. */
function readSamples(text, issues) {
  const samples = [];
  const malformed = [];
  const repeated = [];
  const seen = new Set();
  const lines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index++) {
    const content = lines[index].replace(/#.*/, "").trim();
    if (!content) continue;
    const fields = content.split(/\s+/);
    const values = fields.slice(0, 7).map(Number);
    const integral = [0, 1, 6].every((k) => Number.isInteger(values[k]));
    if (fields.length < 7 || values.some((value) => !Number.isFinite(value)) || !integral) {
      malformed.push(index + 1);
      continue;
    }
    const [id, type, x, y, z, r, parent] = values;
    if (seen.has(id)) {
      repeated.push(index + 1);
      continue;
    }
    seen.add(id);
    // Single precision, as MorphIO stores points and diameters, so results follow NeuroM's.
    const f = Math.fround;
    samples.push({ id, type, x: f(x), y: f(y), z: f(z), r: f(2 * r) / 2, parent: parent < 0 ? -1 : parent, line: index + 1 });
  }
  if (malformed.length) {
    issue(issues, "malformed-line", "error", `${plural(malformed.length, "line")} without 7 numeric columns skipped`, malformed, true);
  }
  if (repeated.length) {
    issue(issues, "duplicate-id", "error", `${plural(repeated.length, "repeated sample id")}: the first of each was kept`, repeated, true);
  }
  return samples;
}

/** Orphans become roots and every cycle is cut at the sample that closes it. */
function connect(samples, issues) {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const orphans = samples.filter((s) => s.parent !== -1 && !byId.has(s.parent));
  for (const s of orphans) s.parent = -1;
  if (orphans.length) {
    issue(issues, "missing-parent", "error", `${plural(orphans.length, "sample")} named a missing parent and now start a tree`, orphans.map((s) => s.line), true);
  }
  const state = new Map();
  const cut = [];
  for (const start of samples) {
    const path = [];
    let s = start;
    while (s && s.parent !== -1 && !state.has(s.id)) {
      state.set(s.id, "open");
      path.push(s);
      s = byId.get(s.parent);
      if (s && state.get(s.id) === "open") {
        const closing = path[path.length - 1];
        closing.parent = -1;
        cut.push(closing.line);
        break;
      }
    }
    for (const visited of path) state.set(visited.id, "done");
  }
  if (cut.length) issue(issues, "cycle", "error", `${plural(cut.length, "parent cycle")} cut; the sample that closed each now starts a tree`, cut, true);
}

/** Parents before children, keeping file order otherwise (depth-first from each root in file order). */
function sortSamples(samples, issues) {
  const index = new Map(samples.map((s, k) => [s.id, k]));
  const unsorted = samples.filter((s) => s.parent !== -1 && index.get(s.parent) > index.get(s.id));
  if (!unsorted.length) return samples;
  issue(issues, "unsorted", "info", `${plural(unsorted.length, "sample")} listed before their parent; the repaired file is sorted`, unsorted.map((s) => s.line), true);
  const children = childMap(samples);
  const order = [];
  const stack = samples.filter((s) => s.parent === -1).reverse();
  while (stack.length) {
    const s = stack.pop();
    order.push(s);
    for (const child of [...(children.get(s.id) ?? [])].reverse()) stack.push(child);
  }
  return order;
}

function childMap(samples) {
  const children = new Map();
  for (const s of samples) {
    if (s.parent === -1) continue;
    if (!children.has(s.parent)) children.set(s.parent, []);
    children.get(s.parent).push(s);
  }
  return children;
}

/**
 * Nonpositive radii take the nearest positive radius above them, else below them,
 * looking only at samples of the same kind (soma or neurite), so a dendrite never
 * borrows the soma's radius.
 */
function repairRadii(samples, byId, children) {
  const fixed = [];
  for (const s of samples) {
    if (s.r > 0) continue;
    const sameKind = (other) => other && (other.type === SOMA) === (s.type === SOMA);
    let source = byId.get(s.parent);
    while (sameKind(source) && !(source.r > 0)) source = byId.get(source.parent);
    if (!sameKind(source)) {
      const queue = (children.get(s.id) ?? []).filter(sameKind);
      while (queue.length && !(queue[0].r > 0)) queue.push(...(children.get(queue.shift().id) ?? []).filter(sameKind));
      source = queue[0];
    }
    if (source) {
      s.r = source.r;
      fixed.push(s.line);
    }
  }
  return fixed;
}

/** A neurite sample at its parent's position is removed; its children move to the parent. */
function mergeDuplicates(samples, byId) {
  const removed = new Set();
  for (const s of samples) {
    const parent = byId.get(s.parent);
    if (!parent || s.type === SOMA || parent.type === SOMA) continue;
    if (s.type !== parent.type) continue;
    if (s.x === parent.x && s.y === parent.y && s.z === parent.z) removed.add(s.id);
  }
  if (!removed.size) return { samples, merged: [] };
  const target = (id) => {
    let current = id;
    while (removed.has(current)) current = byId.get(current).parent;
    return current;
  };
  const kept = [];
  const merged = [];
  for (const s of samples) {
    if (removed.has(s.id)) {
      merged.push(s.line);
      continue;
    }
    if (removed.has(s.parent)) s.parent = target(s.parent);
    kept.push(s);
  }
  return { samples: kept, merged };
}

/** Checks that leave the data as it is. */
function inspect(samples, issues, repaired) {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const children = childMap(samples);
  const soma = samples.filter((s) => s.type === SOMA);
  if (!soma.length) {
    issue(issues, "no-soma", "warning", "No soma samples: distances are measured from the first sample", [], false);
  }
  const somaRoots = soma.filter((s) => byId.get(s.parent)?.type !== SOMA);
  if (somaRoots.length > 1) {
    issue(issues, "multiple-somata", "warning", `${somaRoots.length} separate soma groups; the first soma sample is the centre`, somaRoots.map((s) => s.line), false);
  }
  const inNeurite = soma.filter((s) => s.parent !== -1 && byId.get(s.parent).type !== SOMA);
  if (inNeurite.length) {
    issue(issues, "soma-in-neurite", "warning", `${plural(inNeurite.length, "soma sample")} inside a neurite, measured as part of it`, inNeurite.map((s) => s.line), false);
  }
  if (soma.length) {
    const detached = samples.filter((s) => s.type !== SOMA && s.parent === -1);
    if (detached.length) {
      issue(issues, "disconnected-neurite", "warning", `${plural(detached.length, "neurite")} not attached to the soma`, detached.map((s) => s.line), false);
    }
  }
  const custom = samples.filter((s) => !TYPE_NAMES[s.type]);
  if (custom.length) {
    const types = [...new Set(custom.map((s) => s.type))].sort((a, b) => a - b).join(", ");
    issue(issues, "custom-type", "info", `Type ${types} is not soma, axon, basal or apical; counted under All only`, custom.map((s) => s.line), false);
  }
  const changes = samples.filter((s) => {
    const parent = byId.get(s.parent);
    return parent && parent.type !== SOMA && s.type !== SOMA && parent.type !== s.type && children.get(parent.id).length === 1;
  });
  if (changes.length) {
    issue(issues, "type-change", "info", `${plural(changes.length, "neurite")} change type without branching; a section starts there`, changes.map((s) => s.line), false);
  }
  const multifurcations = samples.filter((s) => s.type !== SOMA && (children.get(s.id)?.length ?? 0) > 2);
  if (multifurcations.length) {
    issue(issues, "multifurcation", "info", `${plural(multifurcations.length, "point")} with more than two branches; no angle is measured there`, multifurcations.map((s) => s.line), false);
  }
  const jumps = samples.filter((s) => {
    const parent = byId.get(s.parent);
    return parent && s.type !== SOMA && Math.abs(s.z - parent.z) > Z_JUMP;
  });
  if (jumps.length) {
    issue(issues, "z-jump", "warning", `${plural(jumps.length, "step")} longer than ${Z_JUMP} µm along z, often a section alignment error`, jumps.map((s) => s.line), false);
  }
  if (!repaired) {
    const zero = samples.filter((s) => !(s.r > 0));
    if (zero.length) issue(issues, "nonpositive-radius", "warning", `${plural(zero.length, "sample")} with zero or negative radius`, zero.map((s) => s.line), false);
    const duplicates = samples.filter((s) => {
      const parent = byId.get(s.parent);
      return parent && s.type !== SOMA && parent.type === s.type && s.x === parent.x && s.y === parent.y && s.z === parent.z;
    });
    if (duplicates.length) issue(issues, "zero-length-segment", "warning", `${plural(duplicates.length, "sample")} at the position of their parent`, duplicates.map((s) => s.line), false);
  }
}

/**
 * Read an SWC file. Structural faults (malformed lines, repeated ids, missing parents,
 * cycles, order) are always repaired because no tree exists without them. With
 * `repair`, nonpositive radii and samples duplicating their parent's position are fixed too.
 * @param {string} text
 * @param {{ repair?: boolean }} [options]
 * @returns {{ samples: Sample[], issues: Issue[] }}
 */
export function readSwc(text, { repair = true } = {}) {
  const issues = [];
  let samples = readSamples(text, issues);
  if (!samples.length) throw new Error("The file has no SWC samples.");
  connect(samples, issues);
  samples = sortSamples(samples, issues);
  if (repair) {
    const merged = mergeDuplicates(samples, new Map(samples.map((s) => [s.id, s])));
    samples = merged.samples;
    if (merged.merged.length) {
      issue(issues, "zero-length-segment", "warning", `${plural(merged.merged.length, "sample")} at their parent's position merged into it`, merged.merged, true);
    }
    const fixed = repairRadii(samples, new Map(samples.map((s) => [s.id, s])), childMap(samples));
    if (fixed.length) issue(issues, "nonpositive-radius", "warning", `${plural(fixed.length, "zero or negative radius")} replaced by the nearest positive radius`, fixed, true);
  }
  inspect(samples, issues, repair);
  return { samples, issues };
}

/** The samples as SWC text, parents first. */
export function writeSwc(samples, header = []) {
  const format = (value) => {
    for (let digits = 1; digits < 17; digits++) {
      const text = String(Number(value.toPrecision(digits)));
      if (Math.fround(Number(text)) === value) return text;
    }
    return String(value);
  };
  const lines = header.map((line) => `# ${line}`);
  for (const s of samples) lines.push([s.id, s.type, format(s.x), format(s.y), format(s.z), format(s.r), s.parent].join(" "));
  return `${lines.join("\n")}\n`;
}
