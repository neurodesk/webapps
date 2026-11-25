// Output serializers for Dermoscope ABCD: PNG (via fast-png), CSV metrics table, and JSON provenance.
import { encode } from "fast-png";
import { APP, DISCLAIMER } from "./config.js";

/** Strip image extension to form a clean output filename stem. */
export function outputStem(filename = "lesion") {
  return String(filename).replace(/\.(jpe?g|png)$/i, "") || "lesion";
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function fmt(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return Number(value).toFixed(digits);
}

/** Build the CSV metrics table summarizing experimental ABCD scores, optional TDS, geometry, colors, and preprocessing. */
export function metricsCsv(run, inputName) {
  const { abcd } = run;
  const g = abcd.geometry;
  const s = abcd.scores;
  const rows = [
    ["metric", "value", "unit", "notes"],
    ["input_file", inputName, "", "assumed sRGB; no ICC/EXIF conversion; alpha < 128 excluded"],
    ["original_width", run.originalWidth, "px", ""],
    ["original_height", run.originalHeight, "px", ""],
    ["working_width", run.width, "px", ""],
    ["working_height", run.height, "px", ""],
    ["scale_x", fmt(run.scaleX ?? run.scaleFactor, 6), "ratio", "working_width / original_width"],
    ["scale_y", fmt(run.scaleY ?? run.scaleFactor, 6), "ratio", "working_height / original_height"],
    ["scale_factor", fmt(run.scaleFactor, 6), "ratio", "sqrt(scale_x * scale_y)"],
    ["vignette_coverage", fmt(run.vignetteCoveragePct, 2), "%", "dark-corner mask"],
    ["transparent_coverage", fmt(run.transparentCoveragePct ?? 0, 2), "%", "alpha < 128 excluded"],
    [
      "hair_coverage",
      fmt(run.hairCoveragePct, 2),
      "%",
      run.settings.removeHair ? `DullRazor (${run.repairedPixels ?? run.hairPixelCount} px repaired)` : "disabled",
    ],
    ["repaired_hair_pixels", run.repairedPixels ?? run.hairPixelCount ?? 0, "px", "exact inpainted pixel count"],
    ["segmented", run.segmented ? "true" : "false", "", run.failureReason ?? "ok"],
    ["otsu_threshold", fmt(run.otsuThreshold, 4), "score", "automatic"],
    ["applied_threshold", fmt(run.appliedThreshold, 4), "score", `bias ${run.settings.thresholdBias}`],
    ["area_px", g.areaPx, "px^2", "working resolution"],
    ["area_mm2", fmt(g.areaMm2, 3), "mm^2", g.calibrated ? `calibrated (${run.settings.pixelsPerMm} px/mm)` : "uncalibrated"],
    ["perimeter_px", fmt(g.perimeterPx, 2), "px", "8-connected Kulpa contour"],
    ["perimeter_mm", fmt(g.perimeterMm, 3), "mm", g.calibrated ? "calibrated" : "uncalibrated"],
    ["equivalent_diameter_px", fmt(g.equivalentDiameterPx, 2), "px", "2 * sqrt(A / pi)"],
    ["equivalent_diameter_mm", fmt(g.equivalentDiameterMm, 3), "mm", g.calibrated ? "calibrated" : "uncalibrated"],
    ["major_axis_px", fmt(g.majorAxisPx, 2), "px", "2nd central moment"],
    ["major_axis_mm", fmt(g.majorAxisMm, 3), "mm", g.calibrated ? "calibrated" : "uncalibrated"],
    ["minor_axis_px", fmt(g.minorAxisPx, 2), "px", "2nd central moment"],
    ["minor_axis_mm", fmt(g.minorAxisMm, 3), "mm", g.calibrated ? "calibrated" : "uncalibrated"],
    ["orientation_deg", fmt(g.orientationDeg, 2), "deg", "principal major axis"],
    ["compactness", fmt(g.compactness, 4), "ratio", "P^2 / (4 * pi * A)"],
    ["circularity", fmt(g.circularity, 4), "ratio", "4 * pi * A / P^2"],
    [
      "score_A_asymmetry",
      s.A ?? "",
      "0-2",
      s.A !== null ? `experimental automated; weight 1.3 -> ${fmt(s.weightedA, 2)}` : "unavailable",
    ],
    [
      "asymmetry_major_xor",
      fmt(abcd.asymmetry.major.shapeXorRatio, 4),
      "ratio",
      abcd.asymmetry.major.asymmetric === null
        ? "unavailable"
        : abcd.asymmetry.major.asymmetric
          ? "asymmetric"
          : "symmetric",
    ],
    [
      "asymmetry_minor_xor",
      fmt(abcd.asymmetry.minor.shapeXorRatio, 4),
      "ratio",
      abcd.asymmetry.minor.asymmetric === null
        ? "unavailable"
        : abcd.asymmetry.minor.asymmetric
          ? "asymmetric"
          : "symmetric",
    ],
    ["asymmetry_major_deltaE", fmt(abcd.asymmetry.major.meanColorDeltaE, 2), "CIE76", "mean Lab reflection deltaE"],
    ["asymmetry_minor_deltaE", fmt(abcd.asymmetry.minor.meanColorDeltaE, 2), "CIE76", "mean Lab reflection deltaE"],
    [
      "score_B_border",
      s.B ?? "",
      "0-8",
      s.B !== null
        ? `experimental automated (${abcd.border.availableSectors}/8 sectors measurable); weight 0.1 -> ${fmt(s.weightedB, 2)}`
        : "unavailable",
    ],
    [
      "score_C_color",
      s.C ?? "",
      "1-6",
      s.C !== null ? `experimental automated; weight 0.5 -> ${fmt(s.weightedC, 2)}` : "unavailable",
    ],
    [
      "score_D_differential_structures",
      s.D ?? "",
      "1-5",
      s.D !== null ? `optional clinician/educational input; weight 0.5 -> ${fmt(s.weightedD, 2)}` : "not scored (A/B/C only)",
    ],
    [
      "tds_total_dermoscopy_score",
      fmt(s.tds, 2),
      "score",
      s.tds !== null
        ? "1.3A + 0.1B + 0.5C + 0.5D (Nachbar & Stolz weights evaluated on clinician-scored lesions)"
        : s.D !== null && abcd.border.unavailableSectors > 0
          ? `not computed (${abcd.border.unavailableSectors}/8 border sectors unavailable)`
          : abcd.border.unavailableSectors > 0
            ? `not computed (enter D; ${abcd.border.unavailableSectors}/8 border sectors unavailable)`
            : "not computed (enter D to calculate)",
    ],
  ];

  for (let i = 0; i < abcd.border.sectorGradients.length; i++) {
    const grad = abcd.border.sectorGradients[i];
    const abrupt = abcd.border.abruptSectors[i];
    const valid = abcd.border.sectorValidSamples?.[i] ?? 0;
    const total = abcd.border.sectorTotalPoints?.[i] ?? 0;
    rows.push([
      `border_sector_${i + 1}_weighted_lab_contrast`,
      fmt(grad, 2),
      "weighted_Lab_contrast",
      abrupt === null
        ? `unavailable (${valid}/${total} samples; 0.7*CIE76 + 0.3*|dL*|)`
        : `${abrupt ? "abrupt" : "gradual"} (${valid}/${total} samples; 0.7*CIE76 + 0.3*|dL*|)`,
    ]);
  }

  for (const entry of abcd.color.breakdown) {
    rows.push([
      `color_${entry.key}_pct`,
      fmt(entry.percentage, 2),
      "%",
      !run.segmented ? "unavailable" : entry.present ? "present (>= 5%)" : "below 5%",
    ]);
  }

  rows.push(["disclaimer", DISCLAIMER, "", "experimental automated morphometry only"]);
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

/** Build the structured JSON provenance record (omitting large pixel arrays). */
export function provenanceRecord(run, inputMeta) {
  const { abcd } = run;
  return {
    app: APP.id,
    title: APP.title,
    version: APP.version,
    timestamp: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    assumptions: {
      colorSpace: "8-bit sRGB assumed as stored (no ICC color-profile conversion or EXIF rotation)",
      alphaHandling: "unpremultiplied RGBA; pixels with alpha < 128 are excluded from preprocessing, segmentation, hole-filling, and morphometry",
      validationStatus: "experimental automated A/B/C morphometry; Nachbar & Stolz (1994) ABCD/TDS weights and thresholds were evaluated on clinician-scored lesions",
    },
    input: {
      name: inputMeta.name,
      bytes: inputMeta.size,
      format: inputMeta.format,
      originalWidth: run.originalWidth,
      originalHeight: run.originalHeight,
    },
    workingDimensions: {
      width: run.width,
      height: run.height,
      scaleX: Number((run.scaleX ?? run.scaleFactor).toFixed(6)),
      scaleY: Number((run.scaleY ?? run.scaleFactor).toFixed(6)),
      scaleFactor: Number(run.scaleFactor.toFixed(6)),
    },
    parameters: { ...run.settings },
    preprocessing: {
      vignetteCoveragePct: Number(run.vignetteCoveragePct.toFixed(3)),
      transparentCoveragePct: Number((run.transparentCoveragePct ?? 0).toFixed(3)),
      hairRemoved: run.settings.removeHair,
      hairCoveragePct: Number(run.hairCoveragePct.toFixed(3)),
      repairedPixels: run.repairedPixels ?? run.hairPixelCount ?? 0,
      hairPixelCount: run.repairedPixels ?? run.hairPixelCount ?? 0,
      colorConstancyApplied: run.settings.colorConstancy,
      illuminantRgb: run.illuminant.map((v) => Number(v.toFixed(5))),
      channelGains: run.gains.map((v) => Number(v.toFixed(5))),
    },
    segmentation: {
      segmented: Boolean(run.segmented),
      failureReason: run.failureReason ?? null,
      contourComplete: run.contourComplete ?? true,
      foregroundBackgroundDeltaE: Number((run.foregroundBackgroundDeltaE ?? 0).toFixed(3)),
      perilesionalSkinLab: {
        L: Number(run.perilesionalSkin.L.toFixed(3)),
        a: Number(run.perilesionalSkin.a.toFixed(3)),
        b: Number(run.perilesionalSkin.b.toFixed(3)),
      },
      otsuThreshold: Number(run.otsuThreshold.toFixed(5)),
      appliedThreshold: Number(run.appliedThreshold.toFixed(5)),
      contourPoints: run.contour.length,
    },
    abcd: {
      segmented: Boolean(run.segmented),
      scores: abcd.scores,
      geometry: {
        ...abcd.geometry,
        centroid: abcd.geometry.centroid.map((v) => Number(v.toFixed(3))),
      },
      asymmetry: abcd.asymmetry,
      border: {
        score: abcd.border.score,
        cutoff: abcd.border.cutoff,
        contrastMetric: abcd.border.contrastMetric,
        availableSectors: abcd.border.availableSectors,
        unavailableSectors: abcd.border.unavailableSectors,
        sectorGradients: abcd.border.sectorGradients.map((v) => (v === null ? null : Number(v.toFixed(3)))),
        abruptSectors: abcd.border.abruptSectors,
        sectorValidSamples: abcd.border.sectorValidSamples,
        sectorTotalPoints: abcd.border.sectorTotalPoints,
        sectorCoverage: abcd.border.sectorCoverage.map((v) => Number(v.toFixed(4))),
      },
      color: {
        score: abcd.color.score,
        thresholdPct: abcd.color.thresholdPct,
        breakdown: abcd.color.breakdown.map(({ id, key, label, pixels, percentage, present }) => ({
          id,
          key,
          label,
          pixels,
          percentage: Number(percentage.toFixed(3)),
          present,
        })),
      },
      diameter: abcd.diameter,
    },
  };
}

/** Encode an RGBA buffer to PNG bytes. */
export function encodeRgbaPng(rgba, width, height) {
  return encode({
    width,
    height,
    data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    channels: 4,
    depth: 8,
  });
}

/** Encode a binary (0/1) mask as an 8-bit grayscale PNG (0 / 255). */
export function encodeMaskPng(mask, width, height) {
  const gray = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    gray[i] = mask[i] ? 255 : 0;
  }
  return encode({
    width,
    height,
    data: gray,
    channels: 1,
    depth: 8,
  });
}

/** Build the four declared downloadable output File objects for the UI and automation. */
export function buildOutputFiles(run, inputMeta) {
  const stem = outputStem(inputMeta.name);
  const preprocessedBytes = encodeRgbaPng(run.preprocessedRgba, run.width, run.height);
  const maskBytes = encodeMaskPng(run.mask, run.width, run.height);
  const csvText = metricsCsv(run, inputMeta.name);
  const record = provenanceRecord(run, inputMeta);
  const jsonText = `${JSON.stringify(record, null, 2)}\n`;
  const s = run.abcd.scores;
  const metricsDesc = !run.segmented
    ? "ABCD metrics · no lesion detected"
    : s.tds !== null
      ? `ABCD metrics · TDS ${s.tds.toFixed(2)}`
      : `ABCD metrics · A${s.A} B${s.B ?? "—"} C${s.C}`;

  return {
    record,
    files: {
      preprocessed: {
        description: "Preprocessed image · PNG",
        file: new File([preprocessedBytes], `${stem}_preprocessed.png`, { type: "image/png" }),
      },
      mask: {
        description: `Lesion mask · ${run.abcd.geometry.areaPx} px`,
        file: new File([maskBytes], `${stem}_mask.png`, { type: "image/png" }),
      },
      metrics: {
        description: metricsDesc,
        file: new File([csvText], `${stem}_abcd_metrics.csv`, { type: "text/csv" }),
      },
      provenance: {
        description: "Provenance report · JSON",
        file: new File([jsonText], `${stem}_provenance.json`, { type: "application/json" }),
      },
    },
  };
}
