import { cruise, getAvailableTranspilers } from 'dependency-cruiser';
import { parseFileSync } from '@swc/core';
import enhancedResolve from 'enhanced-resolve';
import fs from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import {
  browserModules, cruiseOptions, devRuntimeContracts, isGenerated, isProduction,
  isTooling, nodeModules, pureModules, resolveOptions, sourceMirrors, uiModules,
} from '../../../config/dependency-quality.mjs';

export async function workspaceManifests(root) {
  const manifests = new Map();
  for (const parent of ['apps', 'packages', 'site/easter-eggs']) {
    for (const entry of await readdir(resolve(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = `${parent}/${entry.name}`;
      const file = resolve(root, folder, 'package.json');
      if (existsSync(file)) manifests.set(folder, JSON.parse(await readFile(file, 'utf8')));
    }
  }
  return manifests;
}

function ownerOf(path, manifests) {
  return [...manifests.keys()].find((folder) => path.startsWith(`${folder}/`));
}

function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return null;
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function cleanSpecifier(specifier) {
  return specifier.replace(/\?(?:url|raw|inline|worker)(?:&[^]*)?$/, '');
}

// dependency-cruiser extracts static/dynamic imports and require. Supplement
// literal asset and worker URLs and import.meta.resolve, which its parsers omit.
function runtimeReferences(ast) {
  const references = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const first = node.arguments?.[0]?.expression;
    const second = node.arguments?.[1]?.expression;
    if (first?.type === 'StringLiteral') {
      const metaUrl = second?.type === 'MemberExpression'
        && second.object?.type === 'MetaProperty'
        && second.object.kind === 'import.meta'
        && second.property?.value === 'url';
      const metaResolve = node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'MetaProperty'
        && node.callee.object.kind === 'import.meta'
        && node.callee.property?.value === 'resolve';
      if ((node.type === 'NewExpression' && node.callee?.value === 'URL' && metaUrl)
        || (node.type === 'CallExpression' && metaResolve)) references.push({ specifier: first.value, url: node.type === 'NewExpression' });
    }
    Object.values(node).forEach(visit);
  }
  visit(ast);
  return references;
}

const importResolver = enhancedResolve.create.sync({ ...resolveOptions, useSyncFileSystemCalls: true, fileSystem: fs });

function typeOnlySpecifiers(ast) {
  const imports = new Map();
  const dynamic = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      const typeOnly = node.typeOnly || (node.specifiers?.length > 0 && node.specifiers.every((specifier) => specifier.isTypeOnly));
      imports.set(node.source.value, (imports.get(node.source.value) ?? true) && Boolean(typeOnly));
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments?.[0]?.expression?.type === 'StringLiteral') {
      dynamic.add(node.arguments[0].expression.value);
    }
    Object.values(node).forEach(visit);
  }
  visit(ast);
  return new Set([...imports].filter(([specifier, typeOnly]) => typeOnly && !dynamic.has(specifier)).map(([specifier]) => specifier));
}

function resolveReference(root, source, specifier, url = false) {
  if (url && !specifier.includes('://')) {
    const target = posix.normalize(posix.join(dirname(source), specifier));
    return { resolved: target, couldNotResolve: !existsSync(resolve(root, target)), dependencyTypes: ['local'] };
  }
  if (isBuiltin(specifier)) return { resolved: specifier, dependencyTypes: ['core'] };
  if (specifier.includes('://')) return { resolved: specifier, couldNotResolve: true, dependencyTypes: ['unknown'] };
  try {
    const target = importResolver(resolve(root, dirname(source)), cleanSpecifier(specifier));
    return { resolved: relative(root, target).split(sep).join('/'), dependencyTypes: ['local'] };
  } catch {
    const target = specifier.startsWith('.') ? posix.normalize(posix.join(dirname(source), specifier)) : specifier;
    return { resolved: target, couldNotResolve: true, dependencyTypes: ['unknown'] };
  }
}

export async function dependencyGraph(root, files) {
  if (!getAvailableTranspilers().some((parser) => parser.name === 'swc' && parser.available)) {
    throw new Error('The pinned SWC parser is unavailable; refusing a partial dependency graph.');
  }
  const sources = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)
    && !/\.d\.[cm]?ts$/.test(file) && !isGenerated(file));
  const result = await cruise(sources, { ...cruiseOptions, baseDir: root }, resolveOptions);
  const graph = JSON.parse(result.output);
  const sourceSet = new Set(sources);
  const inventory = new Set(files);
  const returned = new Set(graph.modules.map(({ source }) => source));
  const missing = sources.filter((source) => !returned.has(source));
  if (missing.length) throw new Error(`Dependency graph omitted inventory sources: ${missing.join(', ')}`);
  if (!sources.some(isProduction)) throw new Error('Dependency inventory contains no production sources.');
  // Resolve Vite queries as assets while retaining the original import identity.
  for (const module of graph.modules) {
    if (!sourceSet.has(module.source)) continue;
    for (const dependency of module.dependencies) {
      if (cleanSpecifier(dependency.module) !== dependency.module) {
        Object.assign(dependency, resolveReference(root, module.source, dependency.module));
        dependency.couldNotResolve = !existsSync(resolve(root, dependency.resolved));
      }
    }
    const ast = parseFileSync(resolve(root, module.source), {
      ...(/\.[cm]?tsx?$/.test(module.source)
        ? { syntax: 'typescript', tsx: /\.tsx$/.test(module.source) }
        : { syntax: 'ecmascript', jsx: /\.jsx$/.test(module.source) }),
      decorators: true,
    });
    const typeOnly = typeOnlySpecifiers(ast);
    for (const dependency of module.dependencies) {
      dependency.typeOnly = (typeOnly.has(dependency.module) || typeOnly.has(`node:${dependency.module}`)) && !dependency.dynamic;
    }
    for (const { specifier, url } of runtimeReferences(ast)) {
      if (module.dependencies.some((dependency) => dependency.module === specifier)) continue;
      module.dependencies.push({ module: specifier, ...resolveReference(root, module.source, specifier, url), url });
    }
  }
  for (const module of graph.modules) {
    for (const dependency of module.dependencies) {
      const path = dependency.module.startsWith('.')
        ? posix.normalize(posix.join(dirname(module.source), cleanSpecifier(dependency.module)))
        : dependency.resolved;
      const mirror = Object.entries(sourceMirrors).find(([prefix]) => path.startsWith(prefix));
      if (mirror) dependency.resolved = mirror[1] + path.slice(mirror[0].length);
      if (/^(apps|packages)\//.test(dependency.resolved)) {
        // Ignored staged output must not change analysis between clean and built checkouts.
        dependency.couldNotResolve = !inventory.has(dependency.resolved)
          && !(dependency.url && dependency.resolved.endsWith('/')
            && files.some((file) => file.startsWith(dependency.resolved)));
      }
    }
  }
  return graph.modules.filter((module) => sourceSet.has(module.source));
}

function reachable(modules, roots) {
  const bySource = new Map(modules.map((module) => [module.source, module]));
  const reached = new Set();
  function visit(source) {
    if (reached.has(source)) return;
    reached.add(source);
    for (const dependency of bySource.get(source)?.dependencies ?? []) {
      if (!dependency.typeOnly) visit(dependency.resolved);
    }
  }
  roots.forEach(visit);
  return reached;
}

// Each strongly connected component identifies the exact edges participating in
// cycles, including worker URL edges. A different new edge can never replace an
// old baseline violation merely because the number of findings stayed constant.
function cyclicEdges(modules) {
  const bySource = new Map(modules.map((module) => [module.source, module]));
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const stacked = new Set();
  const cycles = new Set();
  let index = 0;
  function visit(source) {
    indices.set(source, index);
    low.set(source, index++);
    stack.push(source);
    stacked.add(source);
    for (const { resolved: target } of bySource.get(source).dependencies) {
      if (!bySource.has(target)) continue;
      if (!indices.has(target)) {
        visit(target);
        low.set(source, Math.min(low.get(source), low.get(target)));
      } else if (stacked.has(target)) low.set(source, Math.min(low.get(source), indices.get(target)));
    }
    if (low.get(source) !== indices.get(source)) return;
    const component = new Set();
    let member;
    do {
      member = stack.pop();
      stacked.delete(member);
      component.add(member);
    } while (member !== source);
    for (const from of component) {
      for (const { resolved: to } of bySource.get(from).dependencies) {
        if (component.has(to)) cycles.add(`${from}\0${to}`);
      }
    }
  }
  for (const source of bySource.keys()) if (!indices.has(source)) visit(source);
  return cycles;
}

export function dependencyFindings(modules, manifests, runtimeContracts = []) {
  const production = modules.filter((module) => isProduction(module.source));
  const browserRoots = production.filter(({ source }) =>
    (source.startsWith('apps/') && !source.includes('/electron/')) || (browserModules.test(source) && !nodeModules.test(source)));
  const nodeRoots = production.filter(({ source }) => nodeModules.test(source) || /^packages\/[^/]+\/bin\//.test(source));
  const browser = reachable(production, browserRoots.map(({ source }) => source));
  const node = reachable(production, nodeRoots.map(({ source }) => source));
  const cycles = cyclicEdges(production.map((module) => ({
    ...module, dependencies: module.dependencies.filter((dependency) => !dependency.typeOnly),
  })));
  const findings = [];
  function add(rule, from, to) { findings.push({ rule, from, to }); }
  for (const { source: from, dependencies } of production) {
    const owner = ownerOf(from, manifests);
    const manifest = manifests.get(owner);
    for (const dependency of dependencies) {
      const to = dependency.resolved;
      const specifier = cleanSpecifier(dependency.module);
      if (isTooling(to)) add('runtime-to-tooling', from, to);
      const targetOwner = ownerOf(to, manifests);
      const targetManifest = manifests.get(targetOwner);
      const name = (dependency.url ? null : packageName(specifier)) ?? (targetOwner !== owner ? targetManifest?.name : null);
      if (from.startsWith('packages/') && to.startsWith('apps/') && !isGenerated(to)) add('shared-to-app', from, to);
      if (from.startsWith('apps/') && to.startsWith('apps/') && !isGenerated(to) && from.split('/')[1] !== to.split('/')[1]) add('app-to-other-app', from, to);
      if ((pureModules.test(from) || from.startsWith('packages/components/src/core/')) && uiModules.test(to)
        && !to.startsWith('packages/components/src/core/')) add('core-to-ui', from, to);
      if (pureModules.test(from) && to.startsWith('packages/components/src/core/')) add('core-to-ui', from, to);
      if (!dependency.typeOnly && browser.has(from) && (nodeModules.test(to) || isBuiltin(specifier) || packageName(specifier) === 'onnxruntime-node')) {
        // NIfTI decompression falls back to zlib only inside its Node branch.
        if (!(from === 'packages/components/src/file-io/NiftiUtils.js' && specifier.replace(/^node:/, '') === 'zlib')) {
          add('browser-to-node', from, to);
        }
      }
      if (!dependency.typeOnly && node.has(from) && ((browserModules.test(to) && !nodeModules.test(to)) || uiModules.test(to))) add('node-to-browser', from, to);
      if (cycles.has(`${from}\0${to}`)) add('cycle', from, to);
      if (dependency.couldNotResolve && !runtimeContracts.some((contract) =>
        contract.from === from && contract.to === dependency.module)) add('unresolved', from, dependency.module);
      if (!manifest || !name || name === manifest.name || isBuiltin(specifier)) continue;
      const runtimeDeclared = [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]
        .some((dependencies) => Object.hasOwn(dependencies ?? {}, name));
      const contract = devRuntimeContracts.some(([path, dependency]) => path === from && dependency === name);
      if (!runtimeDeclared && !((contract || dependency.typeOnly) && Object.hasOwn(manifest.devDependencies ?? {}, name))) {
        add('undeclared-runtime', from, name);
      }
    }
  }
  return [...new Map(findings.map((finding) => [findingIdentity(finding), finding])).values()]
    .sort((left, right) => findingIdentity(left).localeCompare(findingIdentity(right)));
}

export function findingIdentity({ rule, from, to }) {
  return `${rule}\0${from}\0${to}`;
}

export function compareFindings(findings, baseline) {
  const existing = new Set(baseline.map(findingIdentity));
  const current = new Set(findings.map(findingIdentity));
  return {
    added: findings.filter((finding) => !existing.has(findingIdentity(finding))),
    removed: baseline.filter((finding) => !current.has(findingIdentity(finding))),
  };
}

export function validateRuntimeContracts(graph, contracts) {
  const live = new Set(graph.flatMap(({ source, dependencies }) => dependencies
    .filter(({ couldNotResolve }) => couldNotResolve)
    .map(({ module }) => `${source}\0${module}`)));
  for (const { from, to, reason } of contracts) {
    if (!reason?.trim()) throw new Error('Every runtime resolution contract needs a specific reason.');
    if (!live.has(`${from}\0${to}`)) throw new Error(`Remove unused runtime resolution contract: ${from} -> ${to}`);
  }
}
