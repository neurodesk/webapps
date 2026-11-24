#!/usr/bin/env node
// Stage the runtime assets that are fetched by URL at run time (so Vite never
// emits them) into public/, as dwi2trx does: MindGrab's glue + WASM for its three
// backends, Greedy's threaded bundle, and the registration WASM. All three
// folders are gitignored.
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mindgrab = dirname(createRequire(import.meta.url).resolve('@brainchop/core/package.json'))
const stage = (from, to, files) => {
  mkdirSync(to, { recursive: true })
  for (const f of files) copyFileSync(join(from, f), join(to, f))
}
const mindgrabTarget = join(here, '..', 'public', 'mindgrab')
rmSync(mindgrabTarget, { recursive: true, force: true })
stage(join(mindgrab, 'dist', 'models'), join(mindgrabTarget, 'models'), ['mindgrab.bin'])
stage(join(mindgrab, 'dist'), mindgrabTarget, [
  'brainchop-mindgrab-gl.js', 'brainchop-mindgrab-gl.wasm',
  'brainchop-mindgrab.js', 'brainchop-mindgrab.wasm',
])
stage(mindgrab, mindgrabTarget, ['LICENSE'])
stage(join(here, '..', '..', '..', 'packages', 'registration', 'wasm'), join(here, '..', 'public', 'registration'), [
  'syncro-registration.mjs', 'syncro-registration.wasm',
])
const greedyTarget = join(here, '..', 'public', 'greedy-wasm')
rmSync(greedyTarget, { recursive: true, force: true })
cpSync(join(here, '..', '..', '..', 'packages', 'greedy', 'wasm'), greedyTarget, { recursive: true })
