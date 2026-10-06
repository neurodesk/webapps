import React, { useState } from 'react';
import ConstraintBandEditor from '../components/common/ConstraintBandEditor';
import { GradedConstraint, num, hasTarget, hasError, isTol, isRefOnly, targetEdges } from '../components/common/constraintModel';

/**
 * DRAFT playground. Reach it at /constraint-demo. Starts as a single hard exact
 * value; everything else is built by dragging bubbles/notches and right-clicking.
 */

const FIELD = 'MagneticFieldStrength';
const UNIT = 'T';
const INITIAL: GradedConstraint = { value: 3, errorMin: 3, errorMax: 3 };

function serialize(c: GradedConstraint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['value', 'min', 'max', 'errorMin', 'errorMax', 'reference', 'tolerance', 'errorTolerance'] as const) if (num(c[k])) out[k] = c[k];
  if (isRefOnly(c)) out.severity = 'warning';
  return out;
}

// A concise target ("≥ 3 T", "3 to 3.5 T", "3 ± 0.5 T"), plus a quieter detail
// line about what happens outside it.
function describe(c: GradedConstraint): { target: string; detail: string } {
  const n = (x?: number) => `${x} ${UNIT}`;
  if (!hasTarget(c) && !hasError(c) && !num(c.reference) && !num(c.tolerance)) return { target: 'Any value', detail: 'the field just has to be present' };
  if (isRefOnly(c)) return { target: n(c.reference), detail: 'reference — any other value warns, never fails' };
  if (isTol(c)) {
    const detail = !num(c.errorTolerance) ? 'warns outside, never fails'
      : c.errorTolerance > c.tolerance! ? `warns then fails beyond ±${n(c.errorTolerance)}`
      : 'fails outside the tolerance';
    return { target: `${c.value} ± ${n(c.tolerance)}`, detail };
  }
  const { lo, hi } = targetEdges(c);
  const target = num(c.value) ? n(c.value)
    : num(c.min) && num(c.max) ? `${c.min} to ${n(c.max)}`
    : num(c.min) ? `≥ ${n(c.min)}` : `≤ ${n(c.max)}`;
  const tail = (edge: number, err: number | undefined, word: string) =>
    !num(err) ? `warns ${word} the target` : err === edge ? `fails ${word} ${n(err)}` : `warns then fails ${word} ${n(err)}`;
  const parts: string[] = [];
  if (num(lo)) parts.push(tail(lo, c.errorMin, 'below'));
  if (num(hi)) parts.push(tail(hi, c.errorMax, 'above'));
  if (num(c.reference)) parts.push(`reference ${n(c.reference)}`);
  return { target, detail: parts.join('; ') };
}

const ConstraintBandDemo: React.FC = () => {
  const [c, setC] = useState<GradedConstraint>(INITIAL);
  const d = describe(c);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-content-primary">Graded constraint — draft</h1>
      </header>

      <div className="rounded-xl border border-border bg-surface-primary p-5 space-y-5">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-content-primary">{FIELD}</span>
          <span className="text-xs text-content-tertiary">{UNIT}</span>
        </div>

        <ConstraintBandEditor fieldName={FIELD} unit={UNIT} value={c} onChange={setC} />

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1" />
          <button onClick={() => setC(INITIAL)}
            className="px-2.5 py-1 text-xs rounded-md border border-border text-content-secondary hover:bg-surface-secondary">reset</button>
        </div>

        <div className="rounded-md bg-surface-secondary px-3 py-2 text-sm">
          <span className="text-content-tertiary">Reads as: </span>
          <span className="text-content-primary font-medium">{d.target}</span>
          {d.detail && <span className="text-content-tertiary italic text-xs"> — {d.detail}</span>}
        </div>
      </div>

      <div>
        <div className="text-xs font-medium text-content-secondary mb-1.5">Serializes to (flat):</div>
        <pre className="rounded-lg bg-slate-900 text-slate-100 text-xs p-4 overflow-x-auto">
{JSON.stringify({ field: FIELD, ...serialize(c) }, null, 2)}
        </pre>
      </div>
    </div>
  );
};

export default ConstraintBandDemo;
