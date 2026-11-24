import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { version } = require('@brainchop/core/package.json')
const dist = join(dirname(require.resolve('@brainchop/core/package.json')), 'dist')
const root = new URL('../public/brainchop/', import.meta.url)
const target = new URL(`${version}/`, root)
await mkdir(new URL('models/', target), { recursive: true })
for (const old of await readdir(root)) {
  if (old !== version) await rm(new URL(old, root), { recursive: true, force: true })
}
for (const model of ['mindgrab', 'mindmap-fast', 'mindmap', 'mindsnap']) {
  await cp(join(dist, 'models', `${model}.bin`), new URL(`models/${model}.bin`, target))
  for (const backend of ['', '-gl']) {
    for (const extension of ['js', 'wasm']) {
      const name = `brainchop-${model}${backend}.${extension}`
      await cp(join(dist, name), new URL(name, target))
    }
  }
}
await cp(join(dist, 'worker.js'), new URL('worker.js', target))
