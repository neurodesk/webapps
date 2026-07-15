import { execFileSync } from 'node:child_process';

const NON_CODE_PREFIXES = ['docs/', '.changeset/'];
const NON_CODE_FILES = new Set(['README.md', 'LICENSES.md']);

function matrixEntry(app) {
  const toolchains = new Set(app.ci.toolchains);
  return {
    app: app.id,
    path: app.path,
    runtime: app.runtime,
    rust_wasm: toolchains.has('rust-wasm'),
    python_reference: toolchains.has('python-reference'),
    shared_runtime: app.ci.shared_runtime,
  };
}

export function selectAffectedApps(registry, changedPaths = []) {
  if (!changedPaths.length) return registry.apps;

  const appIds = new Set(registry.apps.map((app) => app.id));
  const directlyChanged = new Set();
  let sharedChange = false;

  for (const path of changedPaths) {
    const match = path.match(/^apps\/([^/]+)\//);
    if (match && appIds.has(match[1])) {
      directlyChanged.add(match[1]);
      continue;
    }
    if (NON_CODE_FILES.has(path) || NON_CODE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      continue;
    }
    sharedChange = true;
  }

  if (sharedChange) return registry.apps;
  if (directlyChanged.size === 0) return [];
  return registry.apps.filter((app) => directlyChanged.has(app.id));
}

export function createAppPlan(registry, changedPaths = []) {
  const selected = selectAffectedApps(registry, changedPaths);
  const releasable = selected.filter((app) => app.ci.release);
  const sharedRuntime = selected.filter((app) => app.ci.shared_runtime);
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    selected: Object.freeze(selected),
    apps: Object.freeze({ include: Object.freeze(selected.map(matrixEntry)) }),
    sharedApps: Object.freeze({ include: Object.freeze(sharedRuntime.map(matrixEntry)) }),
    releaseApps: Object.freeze({ include: Object.freeze(releasable.map(matrixEntry)) }),
    allApps: selected.length === registry.apps.length,
  });
}

export function changedPathsFromGit({ base, head = 'HEAD', cwd }) {
  if (!base || /^0+$/.test(base)) return [];
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
