import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GradedConstraint, num, clean, niceStep, snapToGrid, isTol, isRefOnly,
  resolved, targetEdges, boundaries, computeDomain, classify, Region,
  removeMax, removeMin, removeTarget, removeTol, buildMenu,
} from './constraintModel';

/**
 * DRAFT — a graded numeric constraint editor. All model/menu logic lives in
 * ./constraintModel; this file is the rendering + interaction layer only.
 *
 * Edit on the line: drag the diamonds, click a bubble to type, click the ruler for
 * a context menu, drag empty space to pan, scroll to zoom, double-click to fit.
 */

export type { GradedConstraint } from './constraintModel';

interface Props {
  fieldName: string;
  unit?: string;
  value: GradedConstraint;
  onChange: (next: GradedConstraint) => void;
}

type HandleId = 'value' | 'min' | 'max' | 'errorMin' | 'errorMax' | 'reference'
  | 'tolLo' | 'tolHi' | 'errTolLo' | 'errTolHi';

// Layout, in px.
const TOP_PAD = 6, LABEL_H = 14, LANE_H = 15, GAP_ABOVE = 22, TRACK = 36, TICKS = 28, MIN_SEP = 52;
// Interaction tuning.
const SNAP_PX = 7;         // magnetic snap radius while dragging
const DRAG_MARGIN = 0.12;  // fraction of view kept as headroom before it auto-pans
const ZOOM = 1.15;         // wheel zoom factor per notch
const WHEEL_PAN = 0.12;    // fraction of view panned per shift-wheel notch
const PAN_THRESH = 3;      // px of movement that turns a click into a pan
const DBLCLICK_MS = 300;   // window for a second click to count as a double-click

const REGION_FILL: Record<Region, string> = {
  pass: 'bg-emerald-400/70 dark:bg-emerald-500/60',
  warn: 'bg-amber-300/70 dark:bg-amber-400/50',
  fail: 'bg-rose-300/60 dark:bg-rose-500/40',
};

const Bubble: React.FC<{
  v: number; unit?: string; colorClass: string; prefix?: string; suffix?: string;
  onCommit: (n: number) => void; onRemove?: () => void;
}> = ({ v, unit, colorClass, prefix, suffix, onCommit, onRemove }) => {
  const [editing, setEditing] = useState(false);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  if (editing) {
    return (
      <input
        autoFocus type="number" step="any" defaultValue={v}
        onPointerDown={stop}
        onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) onCommit(n); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { const n = parseFloat((e.target as HTMLInputElement).value); if (!isNaN(n)) onCommit(n); setEditing(false); }
          if (e.key === 'Escape') setEditing(false);
        }}
        className="w-14 px-1 py-0.5 text-[10px] tabular-nums rounded border border-brand-400 bg-surface-primary text-content-primary focus:outline-none"
      />
    );
  }
  return (
    <span
      onPointerDown={stop} onClick={() => setEditing(true)}
      className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded cursor-text whitespace-nowrap text-[10px] font-semibold tabular-nums leading-none bg-surface-primary/80 hover:bg-surface-secondary ${colorClass}`}
      title="Click to edit"
    >
      {prefix ? <span className="font-normal opacity-70">{prefix}</span> : null}{clean(v)}{unit ? ` ${unit}` : ''}{suffix ? <span className="font-normal opacity-60"> {suffix}</span> : null}
      {onRemove && (
        <button onPointerDown={stop} onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 -mr-0.5 w-3 h-3 leading-none rounded-full text-content-tertiary hover:text-rose-600 hover:bg-rose-500/10" title="Remove">×</button>
      )}
    </span>
  );
};

type Marker = {
  id: HandleId; v: number; kind: 'target' | 'error' | 'ref';
  onRemove?: () => void; bubbleValue?: number; bubblePrefix?: string; bubbleSuffix?: string; onCommit?: (n: number) => void;
};

const ConstraintBandEditor: React.FC<Props> = ({ fieldName, unit, value: c, onChange }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<HandleId | null>(null);
  const frozenDomain = useRef<[number, number] | null>(null);
  // Whether the edge being dragged started coincident with its error edge (hard),
  // captured once so a graded edge isn't consumed the instant it touches its error
  // edge mid-drag — it stays independent until you release them together.
  const dragHard = useRef<{ lo: boolean; hi: boolean } | null>(null);
  const [trackW, setTrackW] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; rx: number } | null>(null);
  const [preview, setPreview] = useState<GradedConstraint | null>(null); // hovered menu item
  // The window is user-controlled: it does NOT auto-fit on drags or menu edits.
  const [viewport, setViewport] = useState<[number, number]>(() => computeDomain(c));
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const menuOpenAt = useRef(0); // a quick second click on the backdrop = fit

  // Apply a constraint change. When it came from *typing* a value into a bubble
  // (fitIfOffscreen), re-fit the window only if the edit pushed a notch outside
  // the current view — an in-view result leaves the window untouched.
  const commit = useCallback((next: GradedConstraint, fitIfOffscreen: boolean) => {
    onChange(next);
    if (!fitIfOffscreen) return;
    const [lo, hi] = viewportRef.current;
    if (boundaries(resolved(next)).some(p => p < lo || p > hi)) setViewport(computeDomain(next));
  }, [onChange]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el); setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); setPreview(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // Scroll to zoom about the cursor; shift-scroll to pan. Native non-passive so we
  // can preventDefault the page scroll.
  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const [lo, hi] = viewport;
      const sp = hi - lo;
      if (e.shiftKey) {
        const delta = sp * WHEEL_PAN * (e.deltaY > 0 ? 1 : -1);
        setViewport([lo + delta, hi + delta]);
      } else {
        const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const cursor = lo + p * sp;
        const nsp = sp * (e.deltaY > 0 ? ZOOM : 1 / ZOOM);
        setViewport([cursor - p * nsp, cursor + (1 - p) * nsp]);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport]);

  const domain = dragging && frozenDomain.current ? frozenDomain.current : viewport;
  const [dMin, dMax] = domain;
  const span = dMax - dMin || 1;
  const step = niceStep(span / 8);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = Math.ceil(dMin / step) * step; t <= dMax + step * 1e-6; t += step) out.push(Math.round(t / step) * step);
    return out;
  }, [dMin, dMax, step]);
  // Minor gridlines in progressively finer tiers (½, ¼, ⅛ of a major); each tier
  // skips the lines a coarser tier already drew.
  const minorLevels = useMemo(() => {
    const gen = (div: number, coarser: number) => {
      const out: number[] = [];
      const s = step / div, cs = step / coarser;
      for (let t = Math.ceil(dMin / s) * s; t <= dMax + s * 1e-6; t += s) {
        const r = Math.round(t / s) * s;
        if (Math.abs(r / cs - Math.round(r / cs)) > 1e-6) out.push(r);
      }
      return out;
    };
    return [
      { ticks: gen(2, 1), h: 5, cls: 'bg-border-secondary/50' },
      { ticks: gen(4, 2), h: 3, cls: 'bg-border-secondary/30' },
      { ticks: gen(8, 4), h: 2, cls: 'bg-border-secondary/20' },
    ];
  }, [dMin, dMax, step]);
  const pct = useCallback((v: number) => ((v - dMin) / span) * 100, [dMin, span]);
  const valueAtClientX = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return dMin + ((clientX - rect.left) / rect.width) * span;
  };

  // Apply a dragged/typed handle. Reference and tolerance edges are special-cased;
  // otherwise a hard error edge (coincident at drag start) travels with its target
  // edge, while a graded edge holds and is only pushed if the target crosses it.
  const applyHandle = useCallback((id: HandleId, vRaw: number, fit = false) => {
    let v = vRaw;
    if (id === 'reference') { commit({ ...c, reference: v }, fit); return; }
    if (id === 'tolLo' || id === 'tolHi') {
      const t = Math.max(0, id === 'tolLo' ? c.value! - v : v - c.value!);
      const startedHard = dragHard.current ? dragHard.current.lo : (num(c.errorTolerance) && c.errorTolerance === c.tolerance);
      if (startedHard) { commit({ ...c, tolerance: clean(t), errorTolerance: clean(t) }, fit); return; }
      commit({ ...c, tolerance: clean(num(c.errorTolerance) ? Math.min(t, c.errorTolerance) : t) }, fit); return;
    }
    if (id === 'errTolLo' || id === 'errTolHi') {
      const et = Math.max(c.tolerance ?? 0, id === 'errTolLo' ? c.value! - v : v - c.value!);
      commit({ ...c, errorTolerance: clean(et) }, fit); return;
    }
    if (id === 'value' && isTol(c)) { commit({ ...c, value: v }, fit); return; }

    const next: GradedConstraint = { ...c };
    if (id === 'errorMin') { const ceil = num(next.value) ? next.value : num(next.min) ? next.min : Infinity; next.errorMin = Math.min(v, ceil); }
    else if (id === 'errorMax') { const floor = num(next.value) ? next.value : num(next.max) ? next.max : -Infinity; next.errorMax = Math.max(v, floor); }
    else if (id === 'value') {
      const hardLo = dragHard.current ? dragHard.current.lo : (num(c.errorMin) && c.errorMin === c.value);
      const hardHi = dragHard.current ? dragHard.current.hi : (num(c.errorMax) && c.errorMax === c.value);
      next.value = v;
      if (hardLo) next.errorMin = v; else if (num(c.errorMin) && v < c.errorMin) next.errorMin = v;
      if (hardHi) next.errorMax = v; else if (num(c.errorMax) && v > c.errorMax) next.errorMax = v;
    }
    else if (id === 'min') {
      const hardLo = dragHard.current ? dragHard.current.lo : (num(c.errorMin) && c.errorMin === c.min);
      v = Math.min(v, num(c.max) ? c.max : Infinity);
      next.min = v;
      if (hardLo) next.errorMin = v; else if (num(c.errorMin) && v < c.errorMin) next.errorMin = v;
    }
    else if (id === 'max') {
      const hardHi = dragHard.current ? dragHard.current.hi : (num(c.errorMax) && c.errorMax === c.max);
      v = Math.max(v, num(c.min) ? c.min : -Infinity);
      next.max = v;
      if (hardHi) next.errorMax = v; else if (num(c.errorMax) && v > c.errorMax) next.errorMax = v;
    }
    commit(next, fit);
  }, [c, commit]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || !frozenDomain.current) return;
      let [lo, hi] = frozenDomain.current;
      const p = (e.clientX - rect.left) / rect.width;
      const vpp = (hi - lo) / rect.width;
      const st = niceStep((hi - lo) / 8);
      let v = snapToGrid(lo + p * (hi - lo), st); // onto the finest gridline
      // magnetic pull to major ticks and other markers within a few px
      const cands: number[] = [];
      for (let t = Math.ceil(lo / st) * st; t <= hi; t += st) cands.push(Math.round(t / st) * st);
      const cur = dragging === 'reference' ? c.reference : dragging === 'value' ? c.value : dragging === 'min' ? c.min : dragging === 'max' ? c.max : dragging === 'errorMin' ? c.errorMin : c.errorMax;
      for (const m of [c.value, c.min, c.max, c.errorMin, c.errorMax, c.reference]) if (num(m) && m !== cur) cands.push(m);
      let best: number | null = null, bestD = vpp * SNAP_PX;
      for (const t of cands) { const d = Math.abs(v - t); if (d <= bestD) { bestD = d; best = t; } }
      if (best !== null) v = clean(best);
      const margin = (hi - lo) * DRAG_MARGIN; // grow the view outward to follow a handle past the edge
      if (v > hi - margin) frozenDomain.current = [lo, v + margin];
      else if (v < lo + margin) frozenDomain.current = [v - margin, hi];
      applyHandle(dragging, v);
    };
    const up = () => {
      if (frozenDomain.current) setViewport(frozenDomain.current); // keep the settled window
      setDragging(null); frozenDomain.current = null; dragHard.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging, applyHandle, c]);

  // Left-drag on empty ruler space pans; a click (no drag) opens the context menu.
  // Notches/bubbles stopPropagation their pointerdown, so drags on them don't reach here.
  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const [lo, hi] = viewport;
    const vpp = (hi - lo) / rect.width;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > PAN_THRESH) moved = true;
      if (moved) setViewport([lo - dx * vpp, hi - dx * vpp]);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) { setMenu({ x: ev.clientX, y: ev.clientY, rx: valueAtClientX(ev.clientX) }); menuOpenAt.current = Date.now(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startDrag = (id: HandleId) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    frozenDomain.current = [viewport[0], viewport[1]];
    dragHard.current = {
      lo: (id === 'value' && num(c.errorMin) && c.errorMin === c.value) || (id === 'min' && num(c.errorMin) && c.errorMin === c.min) || ((id === 'tolLo' || id === 'tolHi') && num(c.errorTolerance) && c.errorTolerance === c.tolerance),
      hi: (id === 'value' && num(c.errorMax) && c.errorMax === c.value) || (id === 'max' && num(c.errorMax) && c.errorMax === c.max),
    };
    setDragging(id);
  };

  // ---- markers (rendered from `shown` = the hovered preview, else the real value) ----
  const shown = preview ?? c;
  const markers: Marker[] = [];
  if (isTol(shown)) {
    const v = shown.value!, t = shown.tolerance!, et = shown.errorTolerance;
    // Tolerance edge bubbles read "±0.5 (2.5)": the ± tolerance you edit, then position.
    // Typing a new ± goes through applyHandle (as a drag does) so a hard tolerance
    // stays hard — the error edge tracks the target edge instead of leaving a
    // phantom warn band between the new and old tolerance.
    const tolPill = (id: HandleId, pos: number) => ({ bubbleValue: t, bubblePrefix: '±', bubbleSuffix: `(${clean(pos)})`, onCommit: (n: number) => applyHandle(id, id === 'tolLo' ? v - n : v + n, true), onRemove: () => onChange(removeTol(c)) });
    const errPill = (id: HandleId, pos: number) => ({ bubbleValue: et!, bubblePrefix: '±', bubbleSuffix: `(${clean(pos)})`, onCommit: (n: number) => applyHandle(id, id === 'errTolLo' ? v - n : v + n, true), onRemove: () => onChange({ ...c, errorTolerance: undefined }) });
    if (num(et) && et > t) {
      markers.push({ id: 'errTolLo', v: v - et, kind: 'error', ...errPill('errTolLo', v - et) });
      markers.push({ id: 'errTolHi', v: v + et, kind: 'error', ...errPill('errTolHi', v + et) });
    }
    markers.push({ id: 'value', v, kind: 'target', onRemove: () => onChange(removeTarget(c)) });
    markers.push({ id: 'tolLo', v: v - t, kind: 'target', ...tolPill('tolLo', v - t) });
    markers.push({ id: 'tolHi', v: v + t, kind: 'target', ...tolPill('tolHi', v + t) });
    if (num(shown.reference)) markers.push({ id: 'reference', v: shown.reference, kind: 'ref', onRemove: () => onChange({ ...c, reference: undefined }) });
  } else {
    const { lo: tLo, hi: tHi } = targetEdges(shown);
    const twoSided = num(shown.min) && num(shown.max);
    if (num(shown.errorMin) && num(tLo) && shown.errorMin < tLo) markers.push({ id: 'errorMin', v: shown.errorMin, kind: 'error', onRemove: () => onChange({ ...c, errorMin: undefined }) });
    if (num(shown.value)) markers.push({ id: 'value', v: shown.value, kind: 'target', onRemove: () => onChange(removeTarget(c)) });
    if (num(shown.min)) markers.push({ id: 'min', v: shown.min, kind: 'target', onRemove: () => onChange(twoSided ? removeMin(c) : removeTarget(c)) });
    if (num(shown.max)) markers.push({ id: 'max', v: shown.max, kind: 'target', onRemove: () => onChange(twoSided ? removeMax(c) : removeTarget(c)) });
    if (num(shown.errorMax) && num(tHi) && shown.errorMax > tHi) markers.push({ id: 'errorMax', v: shown.errorMax, kind: 'error', onRemove: () => onChange({ ...c, errorMax: undefined }) });
    if (num(shown.reference)) markers.push({ id: 'reference', v: shown.reference, kind: 'ref', onRemove: () => onChange({ ...c, reference: undefined }) });
  }

  // Lane-pack on-screen labels so close ones don't overlap.
  const laneOf = new Map<HandleId, number>();
  let maxLane = 0;
  if (trackW > 0) {
    const withX = markers.filter(m => m.v >= dMin && m.v <= dMax).map(m => ({ id: m.id, x: (pct(m.v) / 100) * trackW })).sort((a, b) => a.x - b.x);
    const lastX: number[] = [];
    for (const { id, x } of withX) { let lane = 0; while (lane < lastX.length && x - lastX[lane] < MIN_SEP) lane++; lastX[lane] = x; laneOf.set(id, lane); }
    maxLane = Math.max(0, lastX.length - 1);
  } else markers.forEach(m => laneOf.set(m.id, 0));

  const bandTop = TOP_PAD + maxLane * LANE_H + LABEL_H + GAP_ABOVE;
  const height = bandTop + TRACK + TICKS;

  const rShown = resolved(shown);
  const cuts = Array.from(new Set([dMin, dMax, ...boundaries(rShown).filter(b => b > dMin && b < dMax)])).sort((a, b) => a - b);
  const slices = cuts.slice(0, -1).map((a, i) => { const b = cuts[i + 1]; return { left: pct(a), width: pct(b) - pct(a), region: classify(rShown, (a + b) / 2) }; });

  const gripColor = (k: Marker['kind']) => k === 'target' ? 'bg-emerald-600' : k === 'error' ? 'bg-rose-500' : 'bg-content-primary';
  const textColor = (k: Marker['kind']) => k === 'target' ? 'text-emerald-700 dark:text-emerald-400' : k === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-content-primary';
  const zIndex = (k: Marker['kind']) => k === 'ref' ? 30 : k === 'error' ? 20 : 10;

  const guideX = menu ? menu.rx : hoverX;
  const refOnly = isRefOnly(shown);

  // Shared marker bits (one definition, used by both on-screen and off-screen paths).
  const bubbleFor = (m: Marker) => (
    <Bubble v={m.bubbleValue ?? m.v} unit={unit} prefix={m.bubblePrefix ?? (m.kind === 'ref' ? 'ref ' : undefined)} suffix={m.bubbleSuffix}
      colorClass={textColor(m.kind)} onCommit={m.onCommit ?? ((n) => applyHandle(m.id, n, true))} onRemove={m.onRemove} />
  );
  const gripKeyDown = (m: Marker) => (e: React.KeyboardEvent) => {
    const d = (e.shiftKey ? step * 10 : step) * (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    if (d) { e.preventDefault(); applyHandle(m.id, m.v + d); }
  };

  return (
    <div className="select-none">
      <div className="flex items-center gap-4 mb-2 text-xs text-content-secondary">
        <span className="flex items-center gap-1.5"><span className={`inline-block w-3 h-3 rounded-sm ${REGION_FILL.pass}`} /> pass</span>
        <span className="flex items-center gap-1.5"><span className={`inline-block w-3 h-3 rounded-sm ${REGION_FILL.warn}`} /> warn</span>
        <span className="flex items-center gap-1.5"><span className={`inline-block w-3 h-3 rounded-sm ${REGION_FILL.fail}`} /> fail</span>
      </div>

      <div
        ref={rulerRef}
        className="relative"
        style={{ height, cursor: 'grab' }}
        onPointerDown={startPan}
        onMouseMove={(e) => setHoverX(valueAtClientX(e.clientX))}
        onMouseLeave={() => setHoverX(null)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, rx: valueAtClientX(e.clientX) }); menuOpenAt.current = Date.now(); }}
      >
        <div ref={trackRef} className="absolute left-0 right-0 rounded-md overflow-hidden border border-border-secondary bg-surface-secondary" style={{ top: bandTop, height: TRACK }}>
          {slices.map((s, i) => (<div key={i} className={`absolute top-0 bottom-0 ${REGION_FILL[s.region]}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} />))}
          {markers.map((m) => {
            const color = m.kind === 'target' ? 'bg-emerald-500' : m.kind === 'error' ? 'bg-rose-500' : (refOnly ? 'bg-emerald-500' : 'bg-content-primary/80');
            return <div key={`line-${m.id}`} className={`absolute top-0 bottom-0 w-0.5 -translate-x-1/2 ${color}`} style={{ left: `${pct(m.v)}%` }} />;
          })}
        </div>

        {guideX !== null && guideX >= dMin && guideX <= dMax && (
          <div className="absolute pointer-events-none -translate-x-1/2" style={{ left: `${pct(guideX)}%`, top: bandTop - 10, height: TRACK + 12 }}>
            <div className={`w-px h-full mx-auto ${menu ? 'bg-brand-500' : 'bg-content-tertiary/60'}`} />
            <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full text-[10px] tabular-nums text-content-tertiary bg-surface-primary/80 px-1 rounded">{clean(snapToGrid(guideX, step))}</span>
            {!menu && (
              <div className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center w-4 h-4 rounded-full bg-brand-500 text-white text-[11px] font-bold leading-none shadow" style={{ top: 10 + TRACK / 2 - 8 }}>+</div>
            )}
          </div>
        )}

        <div className="absolute left-0 right-0" style={{ top: bandTop + TRACK + 3 }}>
          {minorLevels.map((lv, li) => lv.ticks.map((t, i) => (
            <div key={`m${li}-${i}`} className="absolute -translate-x-1/2" style={{ left: `${pct(t)}%` }}>
              <div className={`w-px ${lv.cls}`} style={{ height: lv.h }} />
            </div>
          )))}
          {ticks.map((t, i) => (
            <div key={i} className="absolute flex flex-col items-center" style={{ left: `${pct(t)}%`, transform: 'translateX(-50%)' }}>
              <div className="w-px h-1.5 bg-border-secondary" />
              <span className="mt-0.5 text-[10px] text-content-tertiary tabular-nums">{clean(t)}</span>
            </div>
          ))}
        </div>

        {markers.map((m) => {
          const off = m.v < dMin ? -1 : m.v > dMax ? 1 : 0;
          if (off !== 0) {
            // Off-screen: pin to the near edge as an arrow-tagged pill, still draggable.
            const arrow = (
              <div role="slider" aria-label={m.id} aria-valuenow={m.v} tabIndex={0}
                onPointerDown={startDrag(m.id)} onKeyDown={gripKeyDown(m)}
                className={`px-0.5 leading-none cursor-ew-resize touch-none select-none ${textColor(m.kind)}`}>{off < 0 ? '◀' : '▶'}</div>
            );
            return (
              <div key={m.id} className="absolute flex items-center gap-0.5 rounded border border-border bg-surface-primary/95 shadow px-0.5 py-px"
                style={{ top: bandTop + TRACK / 2, transform: 'translateY(-50%)', zIndex: zIndex(m.kind), ...(off < 0 ? { left: 0 } : { right: 0 }) }}>
                {off < 0 && arrow}{bubbleFor(m)}{off > 0 && arrow}
              </div>
            );
          }
          const lane = laneOf.get(m.id) ?? 0;
          const labelTop = TOP_PAD + (maxLane - lane) * LANE_H;
          const connFrom = labelTop + LABEL_H;
          return (
            <div key={m.id} className="absolute" style={{ left: `${pct(m.v)}%`, top: 0, zIndex: zIndex(m.kind) }}>
              <div className="absolute -translate-x-1/2 w-px bg-border-secondary" style={{ top: connFrom, height: Math.max(0, bandTop - connFrom) }} />
              <div className="absolute -translate-x-1/2" style={{ top: labelTop }}>{bubbleFor(m)}</div>
              <div role="slider" aria-label={m.id} aria-valuenow={m.v} tabIndex={0}
                onPointerDown={startDrag(m.id)} onKeyDown={gripKeyDown(m)}
                className="absolute p-1.5 cursor-ew-resize touch-none group"
                style={{ top: bandTop, left: 0, transform: 'translate(-50%, -50%)' }}>
                <div className={`w-4 h-4 ${m.kind === 'ref' ? 'rounded-full' : 'rotate-45 rounded-[3px]'} border-2 border-surface-primary shadow group-focus:ring-2 group-focus:ring-brand-400 ${gripColor(m.kind)}`} />
              </div>
            </div>
          );
        })}
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40"
            onClick={() => { const dbl = Date.now() - menuOpenAt.current < DBLCLICK_MS; setMenu(null); setPreview(null); if (dbl) setViewport(computeDomain(c)); }}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); setPreview(null); }} />
          <div className="fixed z-50 min-w-[200px] rounded-lg border border-border bg-surface-primary shadow-xl py-1 text-sm" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setPreview(null)}>
            {buildMenu(c, menu.rx, step).map((it, i) => it === 'sep'
              ? <div key={i} className="my-1 border-t border-border" />
              : <button key={i} onMouseEnter={() => setPreview(it.next)} onClick={() => { onChange(it.next); setMenu(null); setPreview(null); }}
                  className="block w-full text-left px-3 py-1.5 hover:bg-surface-secondary text-content-primary">{it.label}</button>)}
          </div>
        </>
      )}
    </div>
  );
};

export default ConstraintBandEditor;
