import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const dist = join(dirname(require.resolve('@brainchop/mindgrab/package.json')), 'dist')
const target = new URL('../public/brainchop/', import.meta.url)
await mkdir(target, { recursive: true })
for (const name of ['worker.js', 'brainchop-16chan18cls-gpu.js', 'brainchop-16chan18cls-gpu.wasm', 'brainchop-16chan18cls-gl.js', 'brainchop-16chan18cls-gl.wasm']) {
  await cp(join(dist, name), new URL(name, target))
}
