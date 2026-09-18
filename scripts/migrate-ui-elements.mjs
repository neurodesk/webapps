#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';

const names = new Map([
  ['renderConsole', 'createConsole'],
  ['renderFileField', 'createFileField'],
  ['renderViewerToolbar', 'createViewerToolbar'],
  ['renderExampleSelector', 'createExampleSelector'],
  ['StageResultList', 'createResultList'],
]);
const paths = new Map([
  ['ui/renderConsole.js', 'elements/console.js'],
  ['ui/renderViewerToolbar.js', 'elements/viewer-toolbar.js'],
  ['ui/renderExampleSelector.js', 'elements/example-selector.js'],
  ['ui/StageResultList.js', 'elements/result-list.js'],
]);
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'vendor', 'public', '.git', '.turbo', 'test-results'].includes(entry.name)) continue;
    const file = `${path}/${entry.name}`;
    if (entry.isDirectory()) await walk(file);
    else files.push(file);
  }
}
for (const path of ['apps', 'templates', 'test', 'docs', 'packages/components/test', 'packages/components/docs']) await walk(path);
let changed = 0;
for (const file of files) {
  if (!/^(apps|templates|test|docs|packages\/components\/(test|docs))\//.test(file)) continue;
  if (!/\.(js|mjs|ts|tsx|html)$/.test(file)) continue;
  if (file.includes('shared-components-parity.test.js') || file.endsWith('AGENTS.md')) continue;
  const source = await readFile(file, 'utf8');
  let output = source;
  for (const [before, after] of names) output = output.replaceAll(before, after);
  for (const [before, after] of paths) {
    output = output.replaceAll(before, after);
    let renamed = before;
    for (const [oldName, newName] of names) renamed = renamed.replaceAll(oldName, newName);
    output = output.replaceAll(renamed, after);
  }
  output = output.replace(/new createResultList\(/g, 'createResultList(');
  // Factories return the element itself. Restrict replacements to bindings in each file.
  const bindings = [...output.matchAll(/(?:const|let)\s+(\w+)(?:\s*:[^=;\n]+)?\s*=\s*create(?:Console|FileField|ViewerToolbar|ExampleSelector)\(/g)].map(match => match[1]);
  for (const name of bindings) output = output.replaceAll(`${name}.root`, name);
  output = output.replaceAll('this.exampleSelector.root', 'this.exampleSelector');
  output = output.replaceAll('exampleControl.root', 'exampleControl');
  output = output.replace(/(fileFields\.(?:primary|lesion|pathological))\.root/g, '$1');
  if (file.endsWith('workflow-vocabulary.test.js')) {
    output = output.replace("import { createFileField, bindFileDrop } from '../src/ui/createFileField.js';", "import { createFileField } from '../src/elements/file-field.js';\nimport { bindFileDrop } from '../src/ui/renderFileField.js';");
  }
  output = output.replaceAll('ui/createFileField.js', 'ui/renderFileField.js');
  if (output === source) continue;
  await writeFile(file, output);
  changed++;
}
console.log(`Migrated ${changed} files.`);
