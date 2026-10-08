// cli/qc.py wiring, with stub executables in place of brainchop and niimath.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dirname, '..', 'cli', 'qc.py')
// Resolved now: the CLI runs under a PATH limited to the stubs and /usr/bin:/bin.
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()

// Each stub logs its argv; brainchop touches its outputs, niimath writes a minimal report.
function stubs() {
  const bin = mkdtempSync(join(tmpdir(), 'bqc-bin-'))
  const log = join(bin, 'argv.log')
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  for (const m of ['16chan18cls', 'mindmap', 'mindsnap', 'mindgrab']) stub(`brainchop-${m}`, 'true')
  stub('niimath', `while [ "$1" != "--json" ]; do shift; done; echo '{"cjv": 1, "provenance": {"air_template": "/x/avg152T1.nii.gz"}}' > "$2"`)
  return { bin, argv: () => readFileSync(log, 'utf8').trim().split('\n') }
}

function runCli(bin, ...args) {
  const out = join(mkdtempSync(join(tmpdir(), 'bqc-out-')), 'qc.json')
  const template = join(bin, 'avg152T1.nii.gz')
  writeFileSync(template, 'test-template')
  const r = spawnSync(python, [cli, '--in', 'T1.nii', '--out', out, '--template', template, ...args], {
    env: { ...process.env, BROWSERQC_BIN: bin, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  })
  return { ...r, report: r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null }
}

test('labels: mindgrab mask, brainchop-<model>, then niimath --qc with the model tissue labels', () => {
  const { bin, argv } = stubs()
  const sidecar = join(bin, 'sub.json')
  writeFileSync(sidecar, '{"SeriesNumber": 5}')
  const { status, report } = runCli(bin, '--model', 'mindsnap', '--bids', sidecar)
  assert.equal(status, 0)
  const [mask, seg, qc] = argv()
  assert.match(mask, /^brainchop-mindgrab \S*T1\.nii --mask \S+mask\.nii -o \S+brain\.nii$/)
  assert.match(seg, /^brainchop-mindsnap \S*T1\.nii -o \S+seg\.nii$/)
  assert.match(qc, /^niimath --qc \S*T1\.nii --seg \S+seg\.nii --csf 87,88,89,90,91,92,93 --wm 85,86,95,96,99,100,101,102,103 --mask \S+mask\.nii --air \S+avg152T1\.nii\.gz --json /)
  assert.equal(report.provenance.segmentation, 'brainchop mindsnap (Desikan-Killiany 104, 24ch)')
  assert.equal(report.provenance.air_template, 'avg152T1.nii.gz')
  assert.deepEqual(report.bids_meta, { SeriesNumber: 5 })
})

test('pve: brainchop-mindmap --pve, fractions passed CSF, GM, WM', () => {
  const { bin, argv } = stubs()
  assert.equal(runCli(bin, '--model', 'mindmap-pve').status, 0)
  const [, seg, qc] = argv()
  assert.match(seg, /^brainchop-mindmap \S*T1\.nii --pve -o \S+pve\.nii$/)
  assert.match(qc, /--pve \S+pve_csf\.nii \S+pve_gm\.nii \S+pve_wm\.nii --mask \S+mask\.nii --air /)
})

test('a missing executable is named', () => {
  const r = runCli(mkdtempSync(join(tmpdir(), 'bqc-empty-')))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /brainchop-mindgrab not found/)
})
