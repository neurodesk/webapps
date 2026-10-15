import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function withBrowserBuild(command, build = 'pnpm build', env = process.env) {
  return env.NEURODESK_E2E_PREBUILT === '1' ? command : `${build} && ${command}`;
}

// Multi-stage suites share one build with Playwright and the standalone smoke drivers.
function runBrowserTests(command, env = process.env) {
  if (env.NEURODESK_E2E_PREBUILT !== '1') {
    const build = spawnSync('pnpm build', { shell: true, stdio: 'inherit', env });
    if (build.status !== 0) return build.status ?? 1;
  }
  const tests = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: { ...env, NEURODESK_E2E_PREBUILT: '1' },
  });
  return tests.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Expected one browser test command');
  process.exitCode = runBrowserTests(process.argv[2]);
}
