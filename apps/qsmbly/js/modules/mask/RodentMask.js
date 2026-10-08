/**
 * Rodent brain-masking helpers: voxel-scaled BET, and the export notes for masks qsmxt cannot
 * reproduce (scaled BET, RS2-Net).
 *
 * BET's surface model is tuned for the human brain in millimetres: it searches 7 mm / 3 mm
 * along each vertex normal for the local min/max intensity and bounds the surface curvature
 * between 3.33 mm and 10 mm radii (see qsm-core's bet/evolution.rs, after FSL-BET2). A mouse
 * brain is ~10 x 15 x 8 mm, so those distances span the whole head: the search runs straight
 * through the skull and the curvature limits over-smooth the surface.
 *
 * The standard preclinical workaround (e.g. `fslchpixdim` x10 before `bet`) is to inflate the
 * voxel sizes so the brain reaches roughly human dimensions. The mask BET returns is on the same
 * voxel grid either way, so nothing needs scaling back.
 */

export const MOUSE_BET_DEFAULTS = {
  fractionalIntensity: 0.5,
  iterations: 1000,
  subdivisions: 4,
  erosions: 1,
  voxelScale: 10,
};

// Largest field of view (mm) still treated as a rodent scan. Mouse head coils image ~20-30 mm,
// rat ~40 mm; a human brain alone is >140 mm across.
const RODENT_MAX_FOV_MM = 60;

/** Physical extent of the volume along each axis, in mm. */
export function fieldOfViewMm(dims, voxelSize) {
  if (!dims || !voxelSize) return null;
  return dims.slice(0, 3).map((n, i) => n * (voxelSize[i] || 1));
}

/**
 * True when the field of view is too small to hold a human brain, i.e. BET's human-scale
 * defaults will fail and the voxel-scaled mouse variant should be used instead.
 */
export function looksLikeRodentFov(dims, voxelSize) {
  const fov = fieldOfViewMm(dims, voxelSize);
  if (!fov || fov.some(v => !Number.isFinite(v) || v <= 0)) return false;
  return Math.max(...fov) < RODENT_MAX_FOV_MM;
}

/** Voxel sizes to hand BET: the real ones multiplied by `scale` (>0, default 1 = unchanged). */
export function scaleVoxelSize(voxelSize, scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return voxelSize.map(v => v * s);
}

/**
 * Sentence for the methods section describing the voxel scaling, which the qsmxt `bet:<fi>` mask
 * op cannot express. Returns '' when BET ran unscaled.
 */
export function voxelScaleMethodsNote(scale) {
  if (!(scale > 0) || scale === 1) return '';
  return `To adapt BET's human-scale geometric parameters to the rodent brain, voxel dimensions `
    + `were multiplied by a factor of ${scale} before brain extraction.`;
}

/**
 * Insert `note` into qsmxt's methods markdown right after the sentence describing BET
 * ("... BET brain extraction (Smith, 2002; f=0.50) of ..."), falling back to the end of the
 * text if that sentence isn't found.
 */
export function insertBetMethodsNote(markdown, note) {
  if (!note) return markdown;
  const start = markdown.indexOf('BET brain extraction (');
  if (start >= 0) {
    // Sentence end: a period followed by whitespace (the "f=0.50" decimal point has none).
    const end = /\.(\s|$)/.exec(markdown.slice(start));
    if (end) {
      const at = start + end.index + 1;
      return `${markdown.slice(0, at)} ${note}${markdown.slice(at)}`;
    }
  }
  return `${markdown.trimEnd()}\n\n${note}\n`;
}

/** Methods sentence and reference for an RS2-Net mask (qsmxt has no RS2-Net op). */
export const RS2_NET_METHODS = {
  sentence: 'A brain mask was generated from the magnitude image with RS2-Net (Lin et al., 2024), a '
    + 'deep-learning rodent skull-stripping network, run in QSMbly.',
  reference: '- Lin, Y., Ding, Y., Chang, S., Ge, X., Sui, X., Jiang, Y. (2024). "RS2-Net: An end-to-end deep '
    + 'learning framework for rodent skull stripping in multi-center brain MRI." *NeuroImage*, 298:120769. '
    + 'https://doi.org/10.1016/j.neuroimage.2024.120769',
};

/**
 * Swap qsmxt's masking sentence ("A brain mask was generated using ...") in its methods markdown
 * for `sentence`, add `reference` to the reference list, and drop references the text no longer
 * cites (e.g. Otsu's, when the replaced sentence was the only one citing it). If the masking
 * sentence isn't found, the sentence is appended to the first paragraph's end instead.
 */
export function replaceMaskingSentence(markdown, sentence, reference) {
  const refsAt = markdown.indexOf('## References');
  let body = refsAt >= 0 ? markdown.slice(0, refsAt) : markdown;
  let refs = refsAt >= 0 ? markdown.slice(refsAt) : '';

  const m = /(A brain mask was|Brain masks were) generated/.exec(body);
  const end = m && /\.(\s|$)/.exec(body.slice(m.index));
  if (m && end) {
    body = body.slice(0, m.index) + sentence + body.slice(m.index + end.index + 1);
  } else {
    body = `${body.trimEnd()} ${sentence}\n\n`;
  }

  if (refs) {
    // A reference "- Surname, X. ... (2019)" is cited in the text as "(Surname, 2019)" or
    // "(Surname et al., 2019)".
    const cited = (line) => {
      const r = /^- ([^,]+),.*?\((\d{4})\)/.exec(line);
      if (!r) return true;
      const esc = r[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${esc}(?: et al\\.)?, ${r[2]}`).test(body);
    };
    const lines = refs.trimEnd().split('\n').filter((l) => !l.startsWith('- ') || cited(l));
    refs = `${[...lines, reference].join('\n')}\n`;
  }
  return body + refs;
}
