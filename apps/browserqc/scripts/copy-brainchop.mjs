import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { version } = require('@brainchop/mindgrab/package.json')
const dist = join(dirname(require.resolve('@brainchop/mindgrab/package.json')), 'dist')
const target = new URL(`../public/brainchop/${version}/`, import.meta.url)
await mkdir(target, { recursive: true })
for (const model of ['mindgrab', '16chan18cls', 'mindmap', 'mindsnap']) {
  for (const backend of ['', '-gpu', '-gl']) {
    for (const extension of ['js', 'wasm']) {
      const name = `brainchop-${model}${backend}.${extension}`
      await cp(join(dist, name), new URL(name, target))
    }
  }
}
await cp(join(dist, 'worker.js'), new URL('worker.js', target))
