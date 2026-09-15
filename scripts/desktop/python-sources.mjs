// Refresh explicitly when upgrading Python. Release builds use the checked-in lock.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const sourcesPath = join(root, 'registry/offline-assets.sources.json');
const sources = JSON.parse(await readFile(sourcesPath));
const base = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';
const response = await fetch(`${base}pyodide-lock.json`);
if (!response.ok) throw new Error(`Pyodide lock: HTTP ${response.status}`);
const pyodide = await response.json();
const packages = new Set();
function include(name) {
  name = name.toLowerCase().replace(/[_\.]+/g, "-");
  if (packages.has(name)) return;
  const entry = pyodide.packages[name];
  if (!entry) throw new Error(`Missing Pyodide package: ${name}`);
  packages.add(name);
  for (const dependency of entry.depends) include(dependency);
}
for (const name of ['micropip', 'sqlite3', 'numpy', 'pandas', 'scipy', 'tqdm', 'jsonschema', 'packaging', 'typing-extensions', 'setuptools', 'matplotlib']) include(name);
const assets = [...packages].sort().map(name => ({ url: base + pyodide.packages[name].file_name, sha256: pyodide.packages[name].sha256, kind: 'python-runtime' }));
const wheels = [];
for (const [name, version] of [['pydicom', '2.4.4'], ['tabulate', '0.9.0'], ['nibabel', '5.3.3'], ['twixtools', '0.24'], ['dicompare', '0.6.0']]) {
  const result = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (!result.ok) throw new Error(`${name}: HTTP ${result.status}`);
  const metadata = await result.json();
  const wheel = metadata.urls.find(item => item.filename.endsWith('py3-none-any.whl'));
  if (!wheel) throw new Error(`${name} has no portable wheel`);
  assets.push({ url: wheel.url, sha256: wheel.digests.sha256, bytes: wheel.size, kind: 'python-wheel', license: metadata.info.license });
  wheels.push(wheel.url);
}
for (const id of ['dicompare', 'seedseg', 'qsmbly']) {
  const existing = sources.apps[id].filter(asset => !['python-runtime', 'python-wheel'].includes(asset.kind));
  sources.apps[id] = [...existing, ...assets];
}
sources.python = { base, packages: [...packages].sort(), wheels };
await writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
