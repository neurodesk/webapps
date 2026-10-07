/**
 * DRAFT — pure model + geometry + menu logic for the graded-constraint editor.
 * No React here; everything is a pure function of a GradedConstraint, so it can be
 * unit-tested and reasoned about on its own. The editor component only renders.
 */

export interface GradedConstraint {
  value?: number;         // exact target (a point)
  min?: number;           // range lower / lower bound
  max?: number;           // range upper / upper bound
  errorMin?: number;      // fail edge below the target
  errorMax?: number;      // fail edge above the target
  reference?: number;     // documentation reference (round marker), serialized
  // Tolerance mode: value ± tolerance is the pass zone; warn out to ±errorTolerance,
  // fail beyond. Stored as the half-widths, not the bounds.
  tolerance?: number;
  errorTolerance?: number;
}

export const num = (v: number | undefined): v is number =>
  typeof v === 'number' && !isNaN(v) && isFinite(v);

/** Round away binary-float noise (e.g. 14 * 0.2 = 2.800…03). Numbers only. */
export const clean = (n: number) => Number(n.toFixed(6));

/** A "nice" step (1 / 2 / 5 × 10ⁿ) near `raw`, for the ruler grid. */
export function niceStep(raw: number): number {
  if (raw <= 0 || !isFinite(raw)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const m = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return m * pow;
}

/** Round a value onto the finest gridline (⅛ of a major step). */
export const snapToGrid = (v: number, step: number) => { const g = step / 8; return clean(Math.round(v / g) * g); };

// ---- shape: the single source of truth for "what kind of constraint is this" ----

export const hasTarget = (c: GradedConstraint) => num(c.value) || num(c.min) || num(c.max);
export const hasError = (c: GradedConstraint) => num(c.errorMin) || num(c.errorMax);
export const isTol = (c: GradedConstraint) => num(c.value) && num(c.tolerance);
export const isRefOnly = (c: GradedConstraint) => num(c.reference) && !hasTarget(c) && !hasError(c) && !num(c.tolerance);

export type Shape = 'any' | 'exact' | 'range' | 'tolerance' | 'reference';
export function shape(c: GradedConstraint): Shape {
  if (isTol(c)) return 'tolerance';
  if (num(c.value)) return 'exact';
  if (num(c.min) || num(c.max)) return 'range';
  if (num(c.reference)) return 'reference';
  return 'any';
}

// ---- geometry ----

/** Tolerance resolves to an equivalent symmetric range so range logic works as-is. */
export function resolved(c: GradedConstraint): GradedConstraint {
  if (!isTol(c)) return c;
  const v = c.value!, t = c.tolerance!, et = c.errorTolerance;
  return { reference: c.reference, min: v - t, max: v + t, errorMin: num(et) ? v - et : undefined, errorMax: num(et) ? v + et : undefined };
}

export function targetEdges(c: GradedConstraint): { lo: number; hi: number } {
  if (num(c.value)) return { lo: c.value, hi: c.value };
  return { lo: num(c.min) ? c.min : -Infinity, hi: num(c.max) ? c.max : +Infinity };
}
export function targetCenter(c: GradedConstraint): number {
  if (num(c.value)) return c.value;
  if (num(c.min) && num(c.max)) return (c.min + c.max) / 2;
  if (num(c.min)) return c.min;
  if (num(c.max)) return c.max;
  if (num(c.reference)) return c.reference;
  return 0;
}

/** Whether this constraint can ever produce a WARNING (a value that is neither a
 *  pass nor a hard fail). Governs whether a custom warning message is applicable. */
export function canWarn(c: GradedConstraint): boolean {
  if (isRefOnly(c)) return true;                 // warns everywhere but at the reference
  if (isTol(c)) return !num(c.errorTolerance) || c.errorTolerance > c.tolerance!;
  const { lo, hi } = targetEdges(c);
  const warnBelow = num(lo) && (!num(c.errorMin) || c.errorMin < lo);
  const warnAbove = num(hi) && (!num(c.errorMax) || c.errorMax > hi);
  return warnBelow || warnAbove;
}

/** Whether this constraint can ever produce an ERROR (a hard fail). Reference-only
 *  and advisory constraints never fail, so an error message would be dead. */
export function canError(c: GradedConstraint): boolean {
  if (isTol(c)) return num(c.errorTolerance);
  return num(c.errorMin) || num(c.errorMax);
}
export function boundaries(c: GradedConstraint): number[] {
  return [c.value, c.min, c.max, c.errorMin, c.errorMax, c.reference].filter(num) as number[];
}
export function failEdges(c: GradedConstraint): { lo: number; hi: number } {
  return { lo: num(c.errorMin) ? c.errorMin : -Infinity, hi: num(c.errorMax) ? c.errorMax : +Infinity };
}
export function computeDomain(c: GradedConstraint): [number, number] {
  const marks = boundaries(resolved(c));
  if (num(c.value)) marks.push(c.value);
  if (marks.length === 0) { const ctr = targetCenter(c); return [ctr - 1, ctr + 1]; }
  const lo = Math.min(...marks), hi = Math.max(...marks);
  if (lo === hi) { const d = Math.max(Math.abs(lo) * 0.25, 1); return [lo - d, hi + d]; }
  const pad = (hi - lo) * 0.3;
  return [lo - pad, hi + pad];
}

export type Region = 'pass' | 'warn' | 'fail';
export function classify(c: GradedConstraint, v: number): Region {
  if (isRefOnly(c)) return 'warn'; // the pass sliver at the reference is drawn separately
  const { lo, hi } = targetEdges(c);
  if (v >= lo && v <= hi) return 'pass';
  if (v < lo) return num(c.errorMin) ? (v >= c.errorMin ? 'warn' : 'fail') : 'warn';
  return num(c.errorMax) ? (v <= c.errorMax ? 'warn' : 'fail') : 'warn';
}

// ---- transforms (pure: constraint → next constraint) ----
// Guiding rule: an add/remove only changes what it names; unrelated severity is
// preserved (re-anchored) rather than silently reset.

const mapUp = (err: number | undefined, oldE: number, newE: number) => !num(err) ? undefined : err <= oldE ? newE : newE + (err - oldE);
const mapDown = (err: number | undefined, oldE: number, newE: number) => !num(err) ? undefined : err >= oldE ? newE : newE - (oldE - err);

/** Delete the max → collapse to the single value at min; the above band moves in. */
export const removeMax = (c: GradedConstraint): GradedConstraint => ({ ...c, value: c.min, min: undefined, max: undefined, errorMax: mapUp(c.errorMax, c.max!, c.min!) });
export const removeMin = (c: GradedConstraint): GradedConstraint => ({ ...c, value: c.max, min: undefined, max: undefined, errorMin: mapDown(c.errorMin, c.min!, c.max!) });
/** Remove the whole target: reference-only if there's a reference, else allow-any. */
export const removeTarget = (c: GradedConstraint): GradedConstraint => ({ reference: c.reference });
/** Remove the target (pass) tolerance → collapse the pass band to the single value,
 *  leaving every other band exactly where it is:
 *   - graded (errorTolerance > tolerance): the fail edges keep their absolute
 *     positions (value ± errorTolerance); the warn band just fills the removed pass zone.
 *   - hard (errorTolerance === tolerance): the pass edge *is* the fail edge, so it
 *     collapses to a hard exact value.
 *   - advisory / plain (no errorTolerance): a single value (warns/passes as before). */
export const removeTol = (c: GradedConstraint): GradedConstraint => {
  if (!num(c.errorTolerance)) return { value: c.value, reference: c.reference };
  if (c.errorTolerance === c.tolerance) return { value: c.value, errorMin: c.value, errorMax: c.value, reference: c.reference };
  return { value: c.value, errorMin: clean(c.value! - c.errorTolerance), errorMax: clean(c.value! + c.errorTolerance), reference: c.reference };
};

// ---- context menu (declarative: three groups, joined with separators) ----

export type MenuItem = { label: string; next: GradedConstraint } | 'sep';

// One side of a range/point tail, described so the item-selection logic below can be
// written once for both sides (only the concrete field keys differ).
type SideSpec = {
  edge: number; err?: number; graded: boolean; hasEdge: boolean;
  pass: Partial<GradedConstraint>; warnFromPass: Partial<GradedConstraint>; warn: Partial<GradedConstraint>;
  errorFromPass: Partial<GradedConstraint>; error: Partial<GradedConstraint>; here: Partial<GradedConstraint>;
  clampBeyond?: number; addLabel: string; addBound: (beyond?: number) => Partial<GradedConstraint>;
};

function join(...groups: { label: string; next: GradedConstraint }[][]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    if (out.length) out.push('sep');
    out.push(...g);
  }
  return out;
}

/** Concise human reading of a constraint: a `target` string (e.g. "≥ 3 T",
 *  "3 to 3.5 T", "3 ± 0.5 T") plus a quieter `detail` about the outside behaviour. */
export function describeConstraint(c: GradedConstraint, unit?: string): { target: string; detail: string } {
  const u = unit ? ` ${unit}` : '';
  const n = (x?: number) => `${x}${u}`;
  if (!hasTarget(c) && !hasError(c) && !num(c.reference) && !num(c.tolerance)) return { target: 'any value', detail: '' };
  if (isRefOnly(c)) return { target: n(c.reference), detail: '' };
  if (isTol(c)) {
    // Only spell out a genuine graded band; hard/advisory tolerance needs no prose.
    const detail = num(c.errorTolerance) && c.errorTolerance > c.tolerance! ? `warns then fails beyond ±${n(c.errorTolerance)}` : '';
    return { target: `${c.value} ± ${n(c.tolerance)}`, detail };
  }
  const { lo, hi } = targetEdges(c);
  const target = num(c.value) ? n(c.value)
    : num(c.min) && num(c.max) ? `${c.min} to ${n(c.max)}`
    : num(c.min) ? `≥ ${n(c.min)}` : `≤ ${n(c.max)}`;
  // Classify each bounded side of the target: 'warn' (warns beyond, never fails),
  // 'fail' (fails right at the edge), or 'graded' (a warn band then a fail edge).
  const kindOf = (edge: number, err: number | undefined): 'warn' | 'fail' | 'graded' =>
    !num(err) ? 'warn' : err === edge ? 'fail' : 'graded';
  const loKind = num(lo) ? kindOf(lo, c.errorMin) : undefined;
  const hiKind = num(hi) ? kindOf(hi, c.errorMax) : undefined;
  const kinds = [loKind, hiKind].filter((k): k is 'warn' | 'fail' | 'graded' => k !== undefined);
  // A uniformly simple constraint needs no prose: both sides failing is a plain
  // requirement, both warning is reference-only — the target and the severity dot
  // already say it. Any asymmetry (e.g. "fails below; warns above") or a graded
  // band is spelled out so the two sides aren't assumed to match.
  const uniformSimple = kinds.length > 0
    && (kinds.every(k => k === 'warn') || kinds.every(k => k === 'fail'));
  const phrase = (kind: 'warn' | 'fail' | 'graded', err: number | undefined, word: string) =>
    kind === 'graded' ? `warns then fails ${word} ${n(err)}`
    : kind === 'fail' ? `fails ${word}` : `warns ${word}`;
  const parts: string[] = [];
  if (!uniformSimple) {
    if (loKind) parts.push(phrase(loKind, c.errorMin, 'below'));
    if (hiKind) parts.push(phrase(hiKind, c.errorMax, 'above'));
  }
  if (num(c.reference)) parts.push(`reference ${n(c.reference)}`);
  return { target, detail: parts.join('; ') };
}

// ---- schema serialization (backward-compatible with legacy dicompare JSON) ----
//
// The editor denotes hard-vs-soft by where the error edge sits; the schema JSON
// denotes it by presence + `severity`. These translate faithfully: a legacy hard
// `{value, tolerance}` round-trips unchanged, and only a genuinely graded/advisory
// shape emits the new keys. Non-numeric (`contains*`) fields aren't handled here —
// they don't use the number line.

export type SchemaField = {
  value?: number | number[]; min?: number; max?: number; tolerance?: number;
  errorMin?: number; errorMax?: number; errorTolerance?: number;
  reference?: number; severity?: 'error' | 'warning';
};

/** Schema JSON → editor constraint. Returns null for anything the number line
 *  can't represent: contains* (strings) and list-of-number values (arrays) — those
 *  keep their own widgets, though list_number still gets plain tolerance inputs. */
export function fromSchemaField(f: any): GradedConstraint | null {
  if (f == null || f.contains != null || f.contains_any != null || f.contains_all != null) return null;
  if (Array.isArray(f.value)) return null;
  // A non-numeric scalar value (a string/bool enum) isn't representable on the
  // one-axis number line — leave it to the legacy widgets.
  if (f.value != null && typeof f.value !== 'number') return null;
  const ref = num(f.reference) ? { reference: f.reference } : {};
  const graded = num(f.errorMin) || num(f.errorMax) || num(f.errorTolerance);
  const advisory = f.severity === 'warning';
  if (num(f.tolerance) && num(f.value)) {
    if (num(f.errorTolerance)) return { value: f.value, tolerance: f.tolerance, errorTolerance: f.errorTolerance, ...ref };
    if (advisory) return { value: f.value, tolerance: f.tolerance, ...ref };            // warns outside
    return { value: f.value, tolerance: f.tolerance, errorTolerance: f.tolerance, ...ref }; // legacy hard
  }
  if (num(f.min) || num(f.max)) {
    const base: GradedConstraint = { min: num(f.min) ? f.min : undefined, max: num(f.max) ? f.max : undefined, ...ref };
    if (graded) return { ...base, errorMin: num(f.errorMin) ? f.errorMin : undefined, errorMax: num(f.errorMax) ? f.errorMax : undefined };
    if (advisory) return base;                                                          // warns outside
    return { ...base, errorMin: base.min, errorMax: base.max };                         // legacy hard
  }
  if (num(f.value)) {
    if (graded) return { value: f.value, errorMin: num(f.errorMin) ? f.errorMin : undefined, errorMax: num(f.errorMax) ? f.errorMax : undefined, ...ref };
    if (advisory) return { value: f.value, ...ref };                                    // warns outside (≈ reference-only)
    return { value: f.value, errorMin: f.value, errorMax: f.value, ...ref };            // legacy hard
  }
  if (num(f.reference)) return { reference: f.reference };
  return {}; // allow-any
}

/** Editor constraint → schema JSON keys (field/tag added by the caller). */
export function toSchemaField(c: GradedConstraint): SchemaField {
  const out: SchemaField = {};
  if (isRefOnly(c)) return { value: c.reference!, severity: 'warning' };                // option A
  if (num(c.reference)) out.reference = c.reference;
  if (isTol(c)) {
    out.value = c.value!; out.tolerance = c.tolerance!;
    if (num(c.errorTolerance)) { if (c.errorTolerance > c.tolerance!) out.errorTolerance = c.errorTolerance; } // else hard → legacy
    else out.severity = 'warning';                                                      // warns outside
    return out;
  }
  const lo = num(c.value) ? c.value! : c.min;
  const hi = num(c.value) ? c.value! : c.max;
  if (num(c.value)) out.value = c.value;
  if (num(c.min)) out.min = c.min;
  if (num(c.max)) out.max = c.max;
  if (!num(lo) && !num(hi)) return out;                                                 // allow-any (maybe + reference)
  const loClosed = num(lo), hiClosed = num(hi);
  const hardLo = loClosed && c.errorMin === lo, hardHi = hiClosed && c.errorMax === hi;
  const warnLo = loClosed && !num(c.errorMin), warnHi = hiClosed && !num(c.errorMax);
  if ((hardLo || !loClosed) && (hardHi || !hiClosed)) { /* legacy hard: no extra keys */ }
  else if ((warnLo || !loClosed) && (warnHi || !hiClosed)) out.severity = 'warning';    // advisory both sides
  else { if (num(c.errorMin)) out.errorMin = c.errorMin; if (num(c.errorMax)) out.errorMax = c.errorMax; } // graded / mixed
  return out;
}

/** The field-level severity a graded constraint implies: 'warning' when it can
 *  never fail (reference-only / advisory), else undefined (a requirement). This
 *  is exactly how it serializes, so the table's severity dot matches the JSON. */
export const gradedSeverity = (c: GradedConstraint): 'warning' | undefined =>
  toSchemaField(c).severity === 'warning' ? 'warning' : undefined;

export function buildMenu(c: GradedConstraint, rx: number, step: number): MenuItem[] {
  const rrx = snapToGrid(rx, step);
  const A = (label: string, p: Partial<GradedConstraint>) => ({ label, next: { ...c, ...p } as GradedConstraint });
  const raw = (label: string, next: GradedConstraint) => ({ label, next });
  const outside: { label: string; next: GradedConstraint }[] = [];
  const target: { label: string; next: GradedConstraint }[] = [];
  const reference: { label: string; next: GradedConstraint }[] = [];
  // Reference group: last, add or remove the documentation pin.
  const addRef = () => reference.push(num(c.reference) ? raw('Remove reference', { ...c, reference: undefined }) : A('Add reference here', { reference: rrx }));

  switch (shape(c)) {
    case 'reference': {
      const R = c.reference!;
      target.push(raw('Change to target', { value: R, errorMin: R, errorMax: R }));
      target.push(raw('Add target here', { value: rrx, errorMin: rrx, errorMax: rrx, reference: R }));
      reference.push(raw('Remove reference', {})); // → allow any
      break;
    }
    case 'any': {
      target.push(A('Add target here', { value: rrx, errorMin: rrx, errorMax: rrx }));
      addRef();
      break;
    }
    case 'tolerance': {
      const v = c.value!, t = c.tolerance!, et = c.errorTolerance;
      const o = !num(et) ? 'warn' : et > t ? 'graded' : 'hard';
      // Offer only the conversions that make sense for the region actually clicked:
      // inside the tolerance is a pass (no outer ops); the outer band is a warn or
      // an error depending on the outer mode and, when graded, the click distance.
      const d = Math.abs(rrx - v);
      const region = d <= t ? 'pass'
        : o === 'warn' ? 'warn'
        : o === 'hard' ? 'error'
        : d <= et! ? 'warn' : 'error';
      if (region === 'warn') {
        outside.push(A('Change to error', { errorTolerance: t }));      // whole outer → error
        outside.push(A('Error from here', { errorTolerance: clean(d) })); // error beyond the click
      } else if (region === 'error') {
        outside.push(A('Change to warning', { errorTolerance: undefined })); // whole outer → warning
        outside.push(A('Warning range to here', { errorTolerance: clean(Math.max(t, d)) })); // warn out to the click
      }
      target.push(raw('Swap to range', { min: v - t, max: v + t, errorMin: num(et) ? v - et : undefined, errorMax: num(et) ? v + et : undefined, reference: c.reference }));
      // Removing the pass tolerance acts on the target, so offer it only from the pass zone.
      if (region === 'pass') target.push(raw('Remove target tolerance', removeTol(c)));
      addRef();
      break;
    }
    case 'exact':
    case 'range': {
      const { lo, hi } = targetEdges(c);
      const isPoint = num(c.value);
      const side = num(hi) && rrx > hi ? 'right' : num(lo) && rrx < lo ? 'left' : !num(hi) ? 'right' : !num(lo) ? 'left' : 'inside';

      // Outside — severity of the tail on the side clicked (+ the Add-bound shape op).
      // Both sides share one state machine; only the field keys differ, held in `spec`.
      if (side !== 'inside') {
        const spec: SideSpec = side === 'right' ? {
          edge: hi, err: c.errorMax, graded: num(c.errorMax) && c.errorMax > hi, hasEdge: num(c.max),
          pass: isPoint ? { min: c.value, value: undefined, errorMax: undefined } : { max: undefined, errorMax: undefined },
          warnFromPass: { value: c.min, min: undefined, errorMax: undefined }, warn: { errorMax: undefined },
          errorFromPass: { value: c.min, min: undefined, errorMax: c.min }, error: { errorMax: hi },
          here: { errorMax: rrx }, clampBeyond: num(c.errorMax) ? Math.max(c.errorMax, rrx) : undefined,
          addLabel: 'Add target maximum', addBound: (b) => isPoint ? { min: c.value, value: undefined, max: rrx, errorMax: b } : { max: rrx, errorMax: b },
        } : {
          edge: lo, err: c.errorMin, graded: num(c.errorMin) && c.errorMin < lo, hasEdge: num(c.min),
          pass: isPoint ? { max: c.value, value: undefined, errorMin: undefined } : { min: undefined, errorMin: undefined },
          warnFromPass: { value: c.max, max: undefined, errorMin: undefined }, warn: { errorMin: undefined },
          errorFromPass: { value: c.max, max: undefined, errorMin: c.max }, error: { errorMin: lo },
          here: { errorMin: rrx }, clampBeyond: num(c.errorMin) ? Math.min(c.errorMin, rrx) : undefined,
          addLabel: 'Add target minimum', addBound: (b) => isPoint ? { max: c.value, value: undefined, min: rrx, errorMin: b } : { min: rrx, errorMin: b },
        };
        const state = !num(spec.edge) ? 'pass' : !num(spec.err) ? 'warn' : spec.graded ? 'graded' : 'hard';
        const fromPass = state === 'pass';
        if (state !== 'pass') outside.push(A('Change to pass', spec.pass));
        if (state !== 'warn') outside.push(A('Change to warning', fromPass ? spec.warnFromPass : spec.warn));
        if (state !== 'hard') outside.push(A('Change to error', fromPass ? spec.errorFromPass : spec.error));
        if (state === 'hard') outside.push(A('Warning to here', spec.here));
        if (state === 'warn') outside.push(A('Error from here', spec.here));
        if (!spec.hasEdge) target.push(A(spec.addLabel, spec.addBound(fromPass ? rrx : spec.clampBeyond)));
      }

      // Target — shape changes.
      if (num(c.min) && num(c.max)) {
        target.push(raw('Remove target maximum', removeMax(c)));
        target.push(raw('Remove target minimum', removeMin(c)));
        const center = (c.min + c.max) / 2, tol = (c.max - c.min) / 2;
        const et = (num(c.errorMin) || num(c.errorMax)) ? Math.max(num(c.errorMin) ? center - c.errorMin! : 0, num(c.errorMax) ? c.errorMax! - center : 0) : undefined;
        target.push(raw('Swap to tolerance', { value: clean(center), tolerance: clean(tol), errorTolerance: et !== undefined ? clean(et) : undefined, reference: c.reference }));
      }
      if (isPoint) {
        const t0 = clean(Math.max(Math.abs(rrx - c.value!), step / 2));
        const gap = num(c.errorMin) ? c.value! - c.errorMin! : num(c.errorMax) ? c.errorMax! - c.value! : NaN;
        target.push(raw('Add target tolerance', { value: c.value, tolerance: t0, errorTolerance: isFinite(gap) ? clean(t0 + gap) : undefined, reference: c.reference }));
        if (!num(c.reference)) target.push(raw('Change to reference', { reference: c.value }));
      }
      target.push(raw('Remove target', removeTarget(c)));
      addRef();
      break;
    }
  }
  return join(outside, target, reference);
}
