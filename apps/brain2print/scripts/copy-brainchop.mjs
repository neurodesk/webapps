import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageDir = dirname(require.resolve('@brainchop/core/package.json'))
const { version } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const root = new URL('../public/brainchop/', import.meta.url)
// Versioned: the names are fixed across releases, so a cached old worker.js must not meet a newer page.
const target = new URL(`${version}/`, root)
await mkdir(new URL('models/', target), { recursive: true })
for (const old of await readdir(root)) {
  if (old !== version) await rm(new URL(old, root), { recursive: true, force: true })
}
// Pure-JS WebGPU V4 reads models/<name>.bin; -gl is WebGL2 and '' is threaded CPU.
const models = ['mindmap-fast', 'mindmap', 'mindsnap']
const modules = models.flatMap((model) => ['-gl', ''].flatMap((backend) => ['js', 'wasm'].map((ext) => `brainchop-${model}${backend}.${ext}`)))
for (const name of ['worker.js', ...models.map((model) => `models/${model}.bin`), ...modules]) {
  await cp(join(packageDir, 'dist', name), new URL(name, target))
}
