import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageDir = dirname(require.resolve('@brainchop/mindgrab/package.json'))
const { version } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const root = new URL('../public/brainchop/', import.meta.url)
// Versioned: the names are fixed across releases, so a cached old worker.js must not meet a newer page.
const target = new URL(`${version}/`, root)
await mkdir(target, { recursive: true })
for (const old of await readdir(root)) {
  if (old !== version) await rm(new URL(old, root), { recursive: true, force: true })
}
// '' is the threaded CPU module: the page is cross-origin isolated, so `auto` can fall back to it.
const modules = ['16chan18cls', 'mindmap', 'mindsnap'].flatMap((model) => ['-gpu', '-gl', ''].flatMap((backend) => ['js', 'wasm'].map((ext) => `brainchop-${model}${backend}.${ext}`)))
for (const name of ['worker.js', ...modules]) {
  await cp(join(packageDir, 'dist', name), new URL(name, target))
}
