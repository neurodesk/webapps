// Canvas layer builders and HTML report renderer for Dermoscope ABCD.
import { DERMOSCOPIC_COLORS } from "./core/color.js";

/** Build RGBA pixels showing the lesion mask tint and crisp contour boundary. */
export function buildOverlayPixels(mask, boundaryMask, width, height, opacity = 0.5) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  const op = Math.max(0, Math.min(1, opacity));
  if (op === 0) return out;

  const fillAlpha = Math.round(op * 110);
  const borderAlpha = Math.round(Math.min(1, op * 0.65 + 0.35) * 255);

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (boundaryMask[i]) {
      out[o] = 56;
      out[o + 1] = 224;
      out[o + 2] = 160;
      out[o + 3] = borderAlpha;
    } else if (mask[i]) {
      out[o] = 34;
      out[o + 1] = 197;
      out[o + 2] = 132;
      out[o + 3] = fillAlpha;
    }
  }
  return out;
}

/** Build RGBA pixels showing the 6-class Stolz dermoscopic color map inside the lesion. */
export function buildColorMapPixels(colorMap, width, height, opacity = 0.75) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  const op = Math.max(0, Math.min(1, opacity));
  if (op === 0) return out;

  const alpha = Math.round(op * 255);
  for (let i = 0; i < count; i++) {
    const id = colorMap[i];
    if (!id) continue;
    const proto = DERMOSCOPIC_COLORS[id - 1];
    if (!proto) continue;
    const o = i * 4;
    out[o] = proto.rgb[0];
    out[o + 1] = proto.rgb[1];
    out[o + 2] = proto.rgb[2];
    out[o + 3] = alpha;
  }
  return out;
}

/** Draw principal axes and 8 border-sector spokes directly on the 2D canvas. */
export function drawMorphometryGuides(ctx, run, view, ratio, tokens) {
  if (!run.segmented) return;
  const { geometry, border } = run.abcd;
  if (!geometry.areaPx) return;
  const [cx, cy] = geometry.centroid;
  const sx = view.x + (cx + 0.5) * view.scale;
  const sy = view.y + (cy + 0.5) * view.scale;
  const cos = Math.cos(geometry.orientationRad);
  const sin = Math.sin(geometry.orientationRad);
  const halfMajor = (geometry.majorAxisPx / 2) * view.scale;
  const halfMinor = (geometry.minorAxisPx / 2) * view.scale;

  ctx.save();

  // 8 radial sector boundaries (45° apart starting at orientationRad)
  const spokeRadius = Math.max(halfMajor, halfMinor) * 1.15;
  ctx.lineWidth = 1 * ratio;
  ctx.setLineDash([4 * ratio, 4 * ratio]);
  ctx.strokeStyle = tokens.muted;
  for (let s = 0; s < 8; s++) {
    const theta = geometry.orientationRad + (s * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(theta) * spokeRadius, sy + Math.sin(theta) * spokeRadius);
    ctx.stroke();
  }

  // Highlight abrupt sector markers at sector mid-angles
  ctx.setLineDash([]);
  for (let s = 0; s < 8; s++) {
    if (border.abruptSectors[s] !== true) continue;
    const midAngle = geometry.orientationRad + ((s + 0.5) * Math.PI) / 4;
    const mx = sx + Math.cos(midAngle) * spokeRadius * 0.92;
    const my = sy + Math.sin(midAngle) * spokeRadius * 0.92;
    ctx.beginPath();
    ctx.arc(mx, my, 4 * ratio, 0, 2 * Math.PI);
    ctx.fillStyle = tokens.warning;
    ctx.fill();
  }

  // Principal major and minor axes
  ctx.lineWidth = 2 * ratio;
  ctx.strokeStyle = tokens.primary;
  ctx.beginPath();
  ctx.moveTo(sx - cos * halfMajor, sy - sin * halfMajor);
  ctx.lineTo(sx + cos * halfMajor, sy + sin * halfMajor);
  ctx.stroke();

  ctx.lineWidth = 1.5 * ratio;
  ctx.setLineDash([6 * ratio, 3 * ratio]);
  ctx.beginPath();
  ctx.moveTo(sx + sin * halfMinor, sy - cos * halfMinor);
  ctx.lineTo(sx - sin * halfMinor, sy + cos * halfMinor);
  ctx.stroke();

  // Centroid marker
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(sx, sy, 3.5 * ratio, 0, 2 * Math.PI);
  ctx.fillStyle = tokens.primary;
  ctx.fill();
  ctx.restore();
}

function makeTable(doc, caption, header, rows, { numeric = [] } = {}) {
  const wrapper = doc.createElement("div");
  wrapper.className = "nd-table-scroll";
  const table = doc.createElement("table");
  table.className = "nd-data-table";
  const cap = doc.createElement("caption");
  cap.textContent = caption;
  const thead = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  for (const label of header) {
    const th = doc.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = doc.createElement("tbody");
  for (const { cells, flag } of rows) {
    const tr = doc.createElement("tr");
    if (flag) tr.dataset.flag = flag;
    cells.forEach((text, index) => {
      const td = doc.createElement("td");
      if (numeric.includes(index)) td.className = "nd-numeric";
      td.textContent = text;
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  wrapper.append(table);
  return wrapper;
}

/** Build an SVG polar diagram of the 8 border-sector weighted Lab radial contrast values. */
export function borderSectorsSvg(border) {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 78;
  const finiteGrads = border.sectorGradients.filter((v) => v !== null && Number.isFinite(v));
  const maxVal = Math.max(border.cutoff * 1.5, ...finiteGrads, 1);
  const cutoffR = (border.cutoff / maxVal) * maxR;

  const points = border.sectorGradients.map((grad, s) => {
    const angle = (s * Math.PI) / 4 - Math.PI / 2;
    const r = grad === null ? 0 : (grad / maxVal) * maxR;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });
  const polygon = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  const spokes = border.sectorGradients.map((grad, s) => {
    const angle = (s * Math.PI) / 4 - Math.PI / 2;
    const ex = cx + Math.cos(angle) * maxR;
    const ey = cy + Math.sin(angle) * maxR;
    const lx = cx + Math.cos(angle) * (maxR + 15);
    const ly = cy + Math.sin(angle) * (maxR + 15);
    const [px, py] = points[s];
    const marker =
      grad === null
        ? ""
        : `<circle class="${border.abruptSectors[s] ? "nd-chart-marker" : "nd-chart-axis"}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" />`;
    return [
      `<line class="nd-chart-axis" x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" />`,
      marker,
      `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle">S${s + 1}</text>`,
    ].join("");
  }).join("");

  return [
    `<svg class="nd-chart" viewBox="0 0 ${size} ${size}" role="img" aria-label="Border weighted Lab radial contrast across 8 sectors">`,
    `<circle class="nd-chart-gridline" cx="${cx}" cy="${cy}" r="${maxR}" fill="none" />`,
    `<circle class="nd-chart-level" cx="${cx}" cy="${cy}" r="${cutoffR.toFixed(1)}" fill="none" />`,
    spokes,
    finiteGrads.length ? `<polygon class="nd-chart-band-inner" points="${polygon}" />` : "",
    finiteGrads.length ? `<polygon class="nd-chart-median" points="${polygon}" />` : "",
    "</svg>",
  ].join("");
}

/** Populate `#report` with structured experimental ABCD morphometry tables and disclaimer. */
export function renderAbcdReport(container, run, inputName) {
  const doc = container.ownerDocument;
  const { abcd } = run;
  const g = abcd.geometry;
  const s = abcd.scores;

  const stack = doc.createElement("div");
  stack.className = "nd-report-stack";

  const warning = doc.createElement("p");
  warning.className = "nd-message warning";
  warning.textContent = abcd.disclaimer;

  if (!run.segmented) {
    const errorMsg = doc.createElement("p");
    errorMsg.className = "nd-report-lead";
    errorMsg.textContent = `${run.failureReason || "No lesion detected."} Automated A/B/C scores and TDS are unavailable (—).`;
    stack.append(warning, errorMsg);
    container.replaceChildren(stack);
    return;
  }

  const lead = doc.createElement("p");
  lead.className = "nd-report-lead";
  const bLabel = s.B !== null ? String(s.B) : "—";
  const unavailableSectors = abcd.border.unavailableSectors;
  if (s.tds !== null) {
    lead.textContent = `Experimental automated morphometry: A=${s.A}, B=${bLabel}, C=${s.C} · Clinician-entered D=${s.D} · TDS ${s.tds.toFixed(2)}`;
  } else if (s.D !== null && unavailableSectors > 0) {
    lead.textContent = `Experimental automated morphometry: A=${s.A}, B=${bLabel}, C=${s.C} · Clinician-entered D=${s.D} · TDS unavailable (${unavailableSectors}/8 border sectors unavailable)`;
  } else if (unavailableSectors > 0) {
    lead.textContent = `Experimental automated morphometry: A=${s.A}, B=${bLabel}, C=${s.C} · D not scored · TDS unavailable (${unavailableSectors}/8 border sectors unavailable)`;
  } else {
    lead.textContent = `Experimental automated morphometry: A=${s.A}, B=${bLabel}, C=${s.C} · D not scored · TDS not computed`;
  }

  const tdsUnavailableNote =
    s.D !== null && unavailableSectors > 0
      ? `Not computed (${unavailableSectors}/8 border sectors unavailable)`
      : unavailableSectors > 0
        ? `Not computed (enter D; ${unavailableSectors}/8 border sectors unavailable)`
        : "Not computed (enter D to calculate)";

  const borderDetail =
    abcd.border.unavailableSectors > 0
      ? `${s.B ?? "—"} of ${abcd.border.availableSectors} measurable 45° sectors ≥ ${abcd.border.cutoff} weighted Lab contrast (${abcd.border.unavailableSectors} unavailable)`
      : `${s.B ?? "—"} of 8 radial 45° sectors ≥ ${abcd.border.cutoff} weighted Lab contrast`;

  const abcdTable = makeTable(
    doc,
    `Experimental automated ABCD morphometry (${inputName})`,
    ["Criterion", "Score", "Range", "Weight", "Weighted", "Details"],
    [
      {
        cells: [
          "A · Asymmetry (automated)",
          String(s.A),
          "0–2",
          "×1.3",
          s.weightedA.toFixed(2),
          `Major XOR ${(abcd.asymmetry.major.shapeXorRatio * 100).toFixed(1)}% (ΔE ${abcd.asymmetry.major.meanColorDeltaE.toFixed(1)}), Minor XOR ${(abcd.asymmetry.minor.shapeXorRatio * 100).toFixed(1)}% (ΔE ${abcd.asymmetry.minor.meanColorDeltaE.toFixed(1)})`,
        ],
      },
      {
        cells: [
          "B · Border abruptness (automated)",
          bLabel,
          "0–8",
          "×0.1",
          s.weightedB !== null ? s.weightedB.toFixed(2) : "—",
          borderDetail,
        ],
      },
      {
        cells: [
          "C · Color variegation (automated)",
          String(s.C),
          "1–6",
          "×0.5",
          s.weightedC.toFixed(2),
          abcd.color.breakdown.filter((c) => c.present).map((c) => c.label).join(", ") || "1 dominant class",
        ],
      },
      {
        cells: [
          "D · Differential structures (optional input)",
          s.D !== null ? String(s.D) : "Not scored",
          "1–5",
          "×0.5",
          s.weightedD !== null ? s.weightedD.toFixed(2) : "—",
          s.D !== null
            ? g.calibrated
              ? `Clinician/educational input · Eq. diameter ${g.equivalentDiameterMm.toFixed(2)} mm (${g.equivalentDiameterPx.toFixed(1)} px)`
              : `Clinician/educational input · Eq. diameter ${g.equivalentDiameterPx.toFixed(1)} px (uncalibrated)`
            : "Not scored (A/B/C only)",
        ],
      },
      {
        cells: [
          "Composite TDS (1.3A + 0.1B + 0.5C + 0.5D)",
          s.tds !== null ? s.tds.toFixed(2) : "—",
          "1.0–8.9",
          "sum",
          s.tds !== null ? s.tds.toFixed(2) : "—",
          s.tds !== null
            ? "Computed with clinician-entered D (Nachbar & Stolz weights were evaluated on clinician-scored lesions)"
            : tdsUnavailableNote,
        ],
      },
    ],
    { numeric: [1, 3, 4] },
  );

  const colorTable = makeTable(
    doc,
    "Dermoscopic color palette (CIE L*a*b* nearest prototype, ≥ 5% threshold)",
    ["Color class", "Pixels", "Coverage (%)", "Status"],
    abcd.color.breakdown.map((entry) => ({
      cells: [
        entry.label,
        String(entry.pixels),
        entry.percentage.toFixed(2),
        entry.present ? "Present (≥ 5%)" : "Below 5%",
      ],
      flag: entry.present ? "present" : undefined,
    })),
    { numeric: [1, 2] },
  );

  const figure = doc.createElement("figure");
  figure.className = "nd-chart-figure";
  const figCap = doc.createElement("figcaption");
  figCap.textContent = `Border weighted Lab contrast (0.7·ΔE₇₆ + 0.3·|ΔL*|) across 8 sectors (dashed circle = ${abcd.border.cutoff} abruptness cutoff)`;
  figure.append(figCap);
  figure.insertAdjacentHTML("beforeend", borderSectorsSvg(abcd.border));

  const borderSectorTable = makeTable(
    doc,
    "8-sector border weighted Lab contrast (0.7·ΔE₇₆ + 0.3·|ΔL*|)",
    ["Sector", "Weighted Lab contrast", "Valid samples", "Status"],
    abcd.border.sectorGradients.map((grad, idx) => {
      const valid = abcd.border.sectorValidSamples[idx];
      const total = abcd.border.sectorTotalPoints[idx];
      const cov = abcd.border.sectorCoverage[idx] ?? 0;
      const abrupt = abcd.border.abruptSectors[idx];
      return {
        cells: [
          `S${idx + 1}`,
          grad !== null ? grad.toFixed(2) : "—",
          `${valid}/${total} (${(cov * 100).toFixed(0)}%)`,
          abrupt === null
            ? "Unavailable"
            : abrupt
              ? `Abrupt (≥ ${abcd.border.cutoff})`
              : `Gradual (< ${abcd.border.cutoff})`,
        ],
      };
    }),
    { numeric: [1, 2] },
  );

  const geomRows = [
    {
      cells: [
        "Area",
        `${g.areaPx} px²`,
        g.calibrated ? `${g.areaMm2.toFixed(2)} mm²` : "—",
      ],
    },
    {
      cells: [
        "Perimeter",
        `${g.perimeterPx.toFixed(1)} px`,
        g.calibrated ? `${g.perimeterMm.toFixed(2)} mm` : "—",
      ],
    },
    {
      cells: [
        "Equivalent diameter",
        `${g.equivalentDiameterPx.toFixed(1)} px`,
        g.calibrated ? `${g.equivalentDiameterMm.toFixed(2)} mm` : "—",
      ],
    },
    {
      cells: [
        "Major / minor axes",
        `${g.majorAxisPx.toFixed(1)} / ${g.minorAxisPx.toFixed(1)} px`,
        g.calibrated ? `${g.majorAxisMm.toFixed(2)} / ${g.minorAxisMm.toFixed(2)} mm` : "—",
      ],
    },
    {
      cells: [
        "Compactness / circularity",
        `${g.compactness.toFixed(3)} / ${g.circularity.toFixed(3)}`,
        `Angle ${g.orientationDeg.toFixed(1)}°`,
      ],
    },
    {
      cells: [
        "Preprocessing",
        `Vignette ${run.vignetteCoveragePct.toFixed(1)}% · Hair ${run.hairCoveragePct.toFixed(1)}% (${run.repairedPixels} px)`,
        `Otsu ${run.otsuThreshold.toFixed(3)} (applied ${run.appliedThreshold.toFixed(3)})`,
      ],
    },
  ];
  const geomTable = makeTable(
    doc,
    "Lesion geometry & preprocessing",
    ["Measurement", "Working pixels", "Calibrated / detail"],
    geomRows,
    { numeric: [1, 2] },
  );

  const notes = doc.createElement("p");
  notes.className = "nd-report-notes";
  notes.textContent =
    "A, B, and C are experimental automated morphometrics; Nachbar & Stolz (1994) ABCD/TDS thresholds and weights were evaluated on clinician-scored lesions. Methods: DullRazor (Lee et al. 1997), Shades of Gray (Finlayson & Trezzi 2004; Barata et al. 2015), ABCD rule (Nachbar & Stolz 1994; Kasmi & Mokrani 2016).";

  stack.append(warning, lead, abcdTable, colorTable, figure, borderSectorTable, geomTable, notes);
  container.replaceChildren(stack);
}
