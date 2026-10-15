import { spawnSync } from 'node:child_process';

export function withBrowserBuild(command, build = 'pnpm build', env = process.env) {
  return env.NEURODESK_E2E_PREBUILT === '1' ? command : `${build} && ${command}`;
}

// Multi-stage suites share one build with Playwright and the standalone smoke drivers.
export function runBrowserTests(command, env = process.env) {
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
