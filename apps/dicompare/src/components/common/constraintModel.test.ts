import { describe, it, expect } from 'vitest';
import {
  clean, niceStep, snapToGrid, shape, isTol, isRefOnly, hasTarget,
  resolved, targetEdges, classify, computeDomain,
  removeMax, removeMin, removeTarget, removeTol, buildMenu, GradedConstraint, MenuItem,
  fromSchemaField, toSchemaField, gradedSeverity, describeConstraint,
  canWarn, canError,
} from './constraintModel';

const labels = (m: MenuItem[]) => m.filter((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep').map(x => x.label);
const item = (m: MenuItem[], label: string) => m.find((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep' && x.label === label);
const groupCount = (m: MenuItem[]) => m.filter(x => x === 'sep').length + (m.some(x => x !== 'sep') ? 1 : 0);

describe('numeric helpers', () => {
  it('clean kills float noise', () => {
    expect(clean(14 * 0.2)).toBe(2.8);            // 2.8000000000000003 → 2.8
    expect(clean(3 - 0.45)).toBe(2.55);
  });
  it('niceStep gives 1/2/5 × 10ⁿ', () => {
    expect(niceStep(0.18)).toBe(0.2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(0.9)).toBe(1);
  });
  it('snapToGrid rounds to ⅛ of the step, cleanly', () => {
    expect(snapToGrid(3.44, 0.2)).toBe(3.45);      // grain 0.025
    expect(snapToGrid(3.13, 0.2)).toBe(3.125);
  });
});

describe('shape', () => {
  it('classifies each constraint', () => {
    expect(shape({})).toBe('any');
    expect(shape({ value: 3 })).toBe('exact');
    expect(shape({ min: 3, max: 5 })).toBe('range');
    expect(shape({ min: 3 })).toBe('range');
    expect(shape({ value: 3, tolerance: 0.5 })).toBe('tolerance');
    expect(shape({ reference: 3 })).toBe('reference');
  });
  it('predicates agree with shape', () => {
    expect(isTol({ value: 3, tolerance: 0.5 })).toBe(true);
    expect(isRefOnly({ reference: 3 })).toBe(true);
    expect(isRefOnly({ reference: 3, value: 3 })).toBe(false); // has a target too
    expect(hasTarget({ reference: 3 })).toBe(false);
  });
});

describe('geometry', () => {
  it('resolves tolerance to a symmetric range', () => {
    expect(resolved({ value: 3, tolerance: 0.5, errorTolerance: 1 }))
      .toEqual({ reference: undefined, min: 2.5, max: 3.5, errorMin: 2, errorMax: 4 });
    expect(resolved({ min: 3, max: 5 })).toEqual({ min: 3, max: 5 }); // non-tolerance passes through
  });
  it('targetEdges handles open bounds', () => {
    expect(targetEdges({ value: 3 })).toEqual({ lo: 3, hi: 3 });
    expect(targetEdges({ min: 3 })).toEqual({ lo: 3, hi: Infinity });
    expect(targetEdges({ max: 5 })).toEqual({ lo: -Infinity, hi: 5 });
  });
  it('computeDomain pads and fits all marks', () => {
    const [lo, hi] = computeDomain({ min: 2, max: 4 });
    expect(lo).toBeLessThan(2);
    expect(hi).toBeGreaterThan(4);
  });
});

describe('classify', () => {
  it('pass / warn / fail for a graded range', () => {
    const c = { min: 3, max: 5, errorMin: 2, errorMax: 6 };
    expect(classify(c, 4)).toBe('pass');
    expect(classify(c, 2.5)).toBe('warn');
    expect(classify(c, 1)).toBe('fail');
    expect(classify(c, 5.5)).toBe('warn');
    expect(classify(c, 7)).toBe('fail');
  });
  it('no error edge → warns outside, never fails', () => {
    const c = { min: 3, max: 5 };
    expect(classify(c, 1)).toBe('warn');
    expect(classify(c, 7)).toBe('warn');
  });
  it('hard exact = fail everywhere but the point', () => {
    const c = { value: 3, errorMin: 3, errorMax: 3 };
    expect(classify(c, 3)).toBe('pass');
    expect(classify(c, 3.1)).toBe('fail');
  });
  it('tolerance classifies via resolved()', () => {
    const c = resolved({ value: 3, tolerance: 0.5, errorTolerance: 1 }); // pass 2.5–3.5, warn to ±1, fail beyond
    expect(classify(c, 3)).toBe('pass');
    expect(classify(c, 2.7)).toBe('pass');  // inside the tolerance
    expect(classify(c, 2.3)).toBe('warn');  // between tolerance and error edge
    expect(classify(c, 1.5)).toBe('fail');
  });
});

describe('transforms preserve unrelated severity', () => {
  it('removeMax collapses to the single value, re-anchoring the far band', () => {
    // hard range → single hard value
    expect(removeMax({ min: 3, max: 3.5, errorMin: 3, errorMax: 3.5 }))
      .toMatchObject({ value: 3, errorMax: 3, min: undefined, max: undefined });
    // graded above (warn 3.5–4) → warn gap re-anchored to the point (3–3.5)
    expect(removeMax({ min: 3, max: 3.5, errorMax: 4 }).errorMax).toBe(3.5);
  });
  it('removeMin mirrors removeMax', () => {
    expect(removeMin({ min: 3, max: 3.5, errorMin: 3, errorMax: 3.5 }))
      .toMatchObject({ value: 3.5, errorMin: 3.5 });
  });
  it('removeTarget keeps only the reference', () => {
    expect(removeTarget({ value: 3, errorMin: 3, errorMax: 3, reference: 2.8 })).toEqual({ reference: 2.8 });
    expect(removeTarget({ value: 3, errorMin: 3, errorMax: 3 })).toEqual({ reference: undefined });
  });
  it('removeTol collapses the pass band but leaves the other bands where they are', () => {
    // hard tolerance: the pass edge is the fail edge → hard exact.
    expect(removeTol({ value: 3, tolerance: 0.5, errorTolerance: 0.5 }))
      .toEqual({ value: 3, errorMin: 3, errorMax: 3, reference: undefined });
    // graded: the fail edges keep their absolute positions (2 and 4), not re-anchored.
    expect(removeTol({ value: 3, tolerance: 0.5, errorTolerance: 1 }))
      .toEqual({ value: 3, errorMin: 2, errorMax: 4, reference: undefined });
    // advisory tolerance (no error edge): a plain single value.
    expect(removeTol({ value: 3, tolerance: 0.5 }))
      .toEqual({ value: 3, reference: undefined });
  });
});

describe('buildMenu', () => {
  const step = 0.2;
  it('groups exact into Outside · Target · Reference', () => {
    const m = buildMenu({ value: 3, errorMin: 3, errorMax: 3 }, 3.6, step);
    expect(groupCount(m)).toBe(3);
    expect(labels(m)).toEqual([
      'Change to pass', 'Change to warning', 'Warning to here',
      'Add target maximum', 'Add target tolerance', 'Change to reference', 'Remove target',
      'Add reference here',
    ]);
  });
  it('menu "Remove target maximum" collapses (matches the × behaviour)', () => {
    const c: GradedConstraint = { min: 3, max: 3.6, errorMin: 3, errorMax: 3.6 };
    const next = item(buildMenu(c, 3.3, step), 'Remove target maximum')!.next;
    expect(next).toEqual(removeMax(c)); // same function, not the old "open the side"
    expect(next.value).toBe(3);
    expect(next.max).toBeUndefined();
  });
  it('reference-only offers Change/Add target and Remove reference (→ any)', () => {
    const m = buildMenu({ reference: 3 }, 4, step);
    expect(labels(m)).toEqual(['Change to target', 'Add target here', 'Remove reference']);
    expect(item(m, 'Remove reference')!.next).toEqual({});
  });
  it('tolerance offers swap + outer severities', () => {
    const m = buildMenu({ value: 3, tolerance: 0.5, errorTolerance: 0.5 }, 4, step); // hard outer, click in error region
    expect(labels(m)).toContain('Change to warning');   // not "all error" (already error there)
    expect(labels(m)).toContain('Swap to range');
    expect(labels(m)).not.toContain('Change to error');
    expect(labels(m)).not.toContain('Remove target tolerance'); // a target op — pass zone only
  });
  it('"Remove target tolerance" is offered only from the pass zone', () => {
    const c: GradedConstraint = { value: 3, tolerance: 0.5, errorTolerance: 1 };
    expect(labels(buildMenu(c, 3.0, step))).toContain('Remove target tolerance');     // pass
    expect(labels(buildMenu(c, 3.8, step))).not.toContain('Remove target tolerance'); // warn
    expect(labels(buildMenu(c, 4.5, step))).not.toContain('Remove target tolerance'); // error
  });
  it('tolerance outer options are scoped to the clicked region', () => {
    // Graded: pass |x-3|<=0.5, warn 0.5..1, error >1.
    const graded: GradedConstraint = { value: 3, tolerance: 0.5, errorTolerance: 1 };
    const inPass = labels(buildMenu(graded, 3.2, step));       // inside the tolerance
    expect(inPass).not.toContain('Change to error');
    expect(inPass).not.toContain('Change to warning');
    expect(inPass).not.toContain('Warning range to here');

    const inWarn = labels(buildMenu(graded, 3.8, step));       // 0.5 < 0.8 <= 1 → warn band
    expect(inWarn).toContain('Change to error');               // change the warn band to error
    expect(inWarn).not.toContain('Warning range to here');     // that belongs to the error region

    const inError = labels(buildMenu(graded, 4.5, step));      // 1.5 > 1 → error zone
    expect(inError).toContain('Warning range to here');
    expect(inError).toContain('Change to warning');
    expect(inError).not.toContain('Change to error');
  });
  it('allow-any offers only Add target / Add reference', () => {
    expect(labels(buildMenu({}, 3, step))).toEqual(['Add target here', 'Add reference here']);
  });
});

describe('schema serialization', () => {
  // The key guarantee: legacy schema fields round-trip byte-for-byte (no error keys
  // or severity sneak in), so loading + re-saving never changes behaviour.
  it.each([
    ['legacy hard exact', { value: 3 }],
    ['legacy hard tolerance', { value: 3, tolerance: 0.1 }],
    ['legacy hard range', { min: 3, max: 5 }],
    ['legacy hard minimum', { min: 1.5 }],
    ['legacy advisory value', { value: 0.24, severity: 'warning' }],
    ['legacy advisory range', { min: 3, max: 5, severity: 'warning' }],
    ['graded range', { min: 3, max: 5, errorMin: 2, errorMax: 6 }],
    ['graded tolerance', { value: 3, tolerance: 0.5, errorTolerance: 1 }],
  ])('%s round-trips unchanged', (_name, json) => {
    expect(toSchemaField(fromSchemaField(json)!)).toEqual(json);
  });

  it('non-number-line fields are not the editor’s job', () => {
    expect(fromSchemaField({ contains: 'MPRAGE' })).toBeNull();
    expect(fromSchemaField({ contains_any: ['SE', 'GR'] })).toBeNull();
    expect(fromSchemaField({ value: [0.7, 0.7], tolerance: 0.05 })).toBeNull(); // list_number
  });

  it('editor states serialize to option-A JSON', () => {
    expect(toSchemaField({ reference: 3 })).toEqual({ value: 3, severity: 'warning' }); // reference-only
    expect(toSchemaField({ min: 3, max: 5 })).toEqual({ min: 3, max: 5, severity: 'warning' }); // advisory
    expect(toSchemaField({ value: 3, errorMin: 3, errorMax: 3, reference: 2.8 }))
      .toEqual({ value: 3, reference: 2.8 }); // hard target + documentation reference
    expect(toSchemaField({ min: 3, max: 5, errorMin: 3, errorMax: 6 })) // hard below, graded above
      .toEqual({ min: 3, max: 5, errorMin: 3, errorMax: 6 });
  });
});

describe('gradedSeverity — reference/advisory is not a requirement', () => {
  it('constraints that can never fail read as reference (warning)', () => {
    expect(gradedSeverity({ reference: 3 })).toBe('warning');          // reference-only
    expect(gradedSeverity({ value: 3 })).toBe('warning');              // advisory exact (warns, never fails)
    expect(gradedSeverity({ min: 3, max: 5 })).toBe('warning');        // advisory range
    expect(gradedSeverity({ value: 3, tolerance: 0.1 })).toBe('warning'); // advisory tolerance
  });
  it('constraints with any failing region read as required (undefined)', () => {
    expect(gradedSeverity({ value: 3, errorMin: 3, errorMax: 3 })).toBeUndefined();      // hard exact
    expect(gradedSeverity({ min: 3, max: 5, errorMin: 3, errorMax: 5 })).toBeUndefined(); // hard range
    expect(gradedSeverity({ value: 3, tolerance: 0.1, errorTolerance: 0.1 })).toBeUndefined(); // hard tolerance
    expect(gradedSeverity({ min: 3, max: 5, errorMin: 2, errorMax: 6 })).toBeUndefined(); // graded
  });
});

describe('canWarn / canError — which custom messages apply', () => {
  it('graded constraints can both warn and error', () => {
    const c = { min: 3, max: 5, errorMin: 2, errorMax: 6 };
    expect(canWarn(c)).toBe(true);
    expect(canError(c)).toBe(true);
  });
  it('hard exact/range only errors (no warn band)', () => {
    expect(canWarn({ value: 3, errorMin: 3, errorMax: 3 })).toBe(false);
    expect(canError({ value: 3, errorMin: 3, errorMax: 3 })).toBe(true);
  });
  it('reference-only / advisory only warns', () => {
    expect(canWarn({ reference: 3 })).toBe(true);
    expect(canError({ reference: 3 })).toBe(false);
    expect(canWarn({ value: 3 })).toBe(true);        // advisory exact
    expect(canError({ value: 3 })).toBe(false);
  });
  it('graded tolerance warns then errors; hard tolerance only errors', () => {
    expect(canWarn({ value: 3, tolerance: 0.5, errorTolerance: 1 })).toBe(true);
    expect(canError({ value: 3, tolerance: 0.5, errorTolerance: 1 })).toBe(true);
    expect(canWarn({ value: 3, tolerance: 0.5, errorTolerance: 0.5 })).toBe(false);
    expect(canError({ value: 3, tolerance: 0.5, errorTolerance: 0.5 })).toBe(true);
  });
  it('open target sides never warn or fail past the open edge', () => {
    expect(canWarn({ min: 3, errorMin: 3 })).toBe(false); // hard min-only
    expect(canError({ min: 3, errorMin: 3 })).toBe(true);
    expect(canWarn({ min: 3 })).toBe(true);               // advisory min-only warns below
    expect(canError({ min: 3 })).toBe(false);
  });
  it('allow-any has no outcomes', () => {
    expect(canWarn({})).toBe(false);
    expect(canError({})).toBe(false);
  });
});

describe('describeConstraint — concise target, band-only detail (no prose)', () => {
  it('spells out only concrete graded bands', () => {
    expect(describeConstraint({ min: 1, max: 5, errorMin: 0.5, errorMax: 6 }))
      .toEqual({ target: '1 to 5', detail: 'warns then fails below 0.5; warns then fails above 6' });
    expect(describeConstraint({ value: 3, tolerance: 0.5, errorTolerance: 1 }))
      .toEqual({ target: '3 ± 0.5', detail: 'warns then fails beyond ±1' });
  });
  it('adds no explainer text for hard, advisory, or reference-only constraints', () => {
    expect(describeConstraint({ value: 3, errorMin: 3, errorMax: 3 }).detail).toBe(''); // hard exact (fails both sides)
    expect(describeConstraint({ min: 3, max: 5 }).detail).toBe('');                     // advisory range (warns both sides)
    expect(describeConstraint({ value: 3, tolerance: 0.1 }).detail).toBe('');           // hard/advisory tolerance
    expect(describeConstraint({ reference: 3 })).toEqual({ target: '3', detail: '' });  // reference-only
    expect(describeConstraint({}).detail).toBe('');                                     // allow-any
  });
  it('spells out asymmetric sides so they are not assumed to match', () => {
    // exact value, fail one side / warn the other
    expect(describeConstraint({ value: 3, errorMin: 3 }).detail).toBe('fails below; warns above');
    expect(describeConstraint({ value: 3, errorMax: 3 }).detail).toBe('warns below; fails above');
    // graded one side, plain the other
    expect(describeConstraint({ value: 3, errorMax: 5 }).detail).toBe('warns below; warns then fails above 5');
    expect(describeConstraint({ min: 1, max: 5, errorMax: 6 }).detail).toBe('warns below; warns then fails above 6');
    // a bounded (hard) minimum only stays clean — the target "≥ 3" already says it
    expect(describeConstraint({ min: 3, errorMin: 3 }).detail).toBe('');
  });
});
