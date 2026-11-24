#!/usr/bin/env node
// Stage @brainchop/core's WebGPU weights into public/ so Vite serves them under
// `assetPath`. They cannot stay in node_modules: these are fetched by URLs
// computed at run time, so Vite never emits them. WebGPU only — see AGENTS.md.

import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const from = join(dirname(require.resolve('@brainchop/core/package.json')), 'dist')
const to = join(here, '..', 'public', 'brainchop')

rmSync(to, { recursive: true, force: true })
mkdirSync(join(to, 'models'), { recursive: true })
for (const f of ['worker.js', 'models/mindgrab.bin']) copyFileSync(join(from, f), join(to, f))
