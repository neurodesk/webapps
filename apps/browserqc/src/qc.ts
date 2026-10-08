/** Column-keyed numeric values in niimath's `--qc` JSON report. */
export type QcMetrics = Record<string, number>

/** niimath's JSON report, with BrowserQC's optional BIDS sidecar. */
export type QcReport = Record<string, unknown> & { provenance: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readQcReport(blob: Blob): Promise<QcReport> {
  const report: unknown = JSON.parse(await blob.text())
  if (!isRecord(report) || !isRecord(report.provenance)) {
    throw new Error('QC output must contain a report object and provenance.')
  }
  return { ...report, provenance: report.provenance }
}

/** Bind a sidecar only to its current image, never a previous one. */
export function bindSidecar(dropMeta: unknown, staged: unknown, files: readonly Pick<File, 'name'>[]): { bind: unknown; staged: unknown } {
  const hasImage = files.some((file) => !file.name.toLowerCase().endsWith('.json'))
  return hasImage ? { bind: dropMeta ?? staged ?? null, staged: null } : { bind: null, staged: dropMeta }
}

// --- Display spec ---
type Better = 'low' | 'high' | null
type MetricSpec = { key: string; label: string; desc: string; better: Better }

// Headline quality IQMs (order = display order).
const QUALITY: MetricSpec[] = [
  { key: 'cjv', label: 'CJV', desc: 'Coefficient of joint variation (noise + INU)', better: 'low' },
  { key: 'cnr', label: 'CNR', desc: 'Contrast-to-noise (GM vs WM over tissue + air noise)', better: 'high' },
  { key: 'snrd_total', label: 'SNRd', desc: 'Dietrich SNR, mean over tissues (air MAD)', better: 'high' },
  { key: 'fber', label: 'FBER', desc: 'Foreground-background energy ratio', better: 'high' },
  { key: 'snr_total', label: 'SNR', desc: 'Signal-to-noise, mean over tissues', better: 'high' },
  { key: 'wm2max', label: 'WM2MAX', desc: 'White-matter median ÷ P99.95 intensity', better: null },
  { key: 'efc_brain', label: 'EFC', desc: 'Entropy focus criterion (ghosting / blur)', better: 'low' },
]

const TISSUES: { key: string; label: string }[] = [
  { key: 'gm', label: 'GM' },
  { key: 'wm', label: 'WM' },
  { key: 'csf', label: 'CSF' },
]

// 3 significant figures, trailing zeros trimmed; nan/inf → em dash.
function num(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return Number(v.toPrecision(3)).toString()
}
function pct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—'
}
function cm3(mm3: number): string {
  return Number.isFinite(mm3) ? `${(mm3 / 1000).toFixed(1)} cm³` : '—'
}
function hint(b: Better): string {
  if (b === 'low') return '<span class="qc-hint" title="lower is better">↓</span>'
  if (b === 'high') return '<span class="qc-hint" title="higher is better">↑</span>'
  return ''
}
const esc = (s: string): string => s.replace(/"/g, '&quot;')

/**
 * Render the QC panel body. `metrics === null` renders the empty state (no QC yet).
 * All values are numbers we produced, so innerHTML is safe.
 */
export function renderQc(body: HTMLElement, metrics: QcMetrics | null): void {
  if (!metrics) {
    body.innerHTML = `<p class="qc-empty">Metrics appear here after processing finishes.</p>`
    return
  }

  const snrDetail = TISSUES.map((t) => `${t.label} ${num(metrics[`snr_${t.key}`])}`).join(' · ')
  const quality = QUALITY.map((m) => {
    const title = m.key === 'snr_total' ? `${m.desc} — ${snrDetail}` : m.desc
    const value = metrics[m.key] ?? NaN
    return `<div class="qc-row" title="${esc(title)}">
      <span class="qc-k">${m.label}${hint(m.better)}</span>
      <span class="qc-v">${num(value)}</span>
    </div>`
  }).join('')

  // Tissue composition: ICV fraction bar + absolute volume.
  const tissues = TISSUES.map((t) => {
    const frac = metrics[`icvs_${t.key}`]
    const w = Number.isFinite(frac) ? Math.max(0, Math.min(100, frac * 100)) : 0
    return `<div class="qc-tissue">
      <span class="qc-tlabel">${t.label}</span>
      <div class="qc-bar"><div class="qc-fill qc-fill-${t.key}" style="width:${w}%"></div></div>
      <span class="qc-tval">${pct(frac)} · ${cm3(metrics[`vol_${t.key}_mm3`])}</span>
    </div>`
  }).join('')

  body.innerHTML = `
    <div class="qc-group">${quality}</div>
    <h4 class="qc-subtitle">Tissue composition <span class="qc-subnote">(% intracranial)</span></h4>
    <div class="qc-group">${tissues}</div>
    <p class="qc-note">MRIQC-style estimates, not MRIQC normative values.</p>`
}
