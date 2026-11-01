import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('publication retries create a missing PR and refresh an existing PR when the branch already matches', async () => {
  const workflow = await readFile(new URL('../.github/workflows/standalone-links.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('      - name: Open or refresh the pull request\n'));
  const match = /^ {8}run: \|\n((?: {10}.*\n|\n)+)/m.exec(step);
  assert.ok(match, 'the publication step has a shell script');
  const script = match[1].replace(/^ {10}/gm, '');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repin-publication-')));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  rev-parse) printf 'previous-head\\n' ;;
  diff) test "$MATCHING_BRANCH" = 1 ;;
esac
`, { mode: 0o755 });
    await writeFile(join(bin, 'gh'), `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$COMMAND_LOG"
case "$1 $2" in
  'pr list') printf '%s' "$OPEN_PR" ;;
  'pr create') test "$FAIL_CREATE" != 1 ;;
  'pr edit') exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    const log = join(root, 'commands.log');
    const run = async (overrides) => {
      await writeFile(log, '');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          COMMAND_LOG: log,
          MATCHING_BRANCH: '0',
          OPEN_PR: '',
          FAIL_CREATE: '0',
          BASE: 'main',
          BRANCH: 'bot/repin-neurocontainers',
          NAMES: 'synthseg',
          RUNNER_TEMP: root,
          GITHUB_REPOSITORY: 'neurodesk/webapps',
          GH_TOKEN: 'fixture-token',
          ...overrides,
        },
      });
      assert.ifError(result.error);
      return { ...result, commands: await readFile(log, 'utf8') };
    };

    const failedCreate = await run({ FAIL_CREATE: '1' });
    assert.notEqual(failedCreate.status, 0, 'a failed PR creation must fail the job');
    assert.match(failedCreate.commands, /^git push /m);
    assert.match(failedCreate.commands, /^gh pr create /m);

    const retry = await run({ MATCHING_BRANCH: '1' });
    assert.equal(retry.status, 0, retry.stderr);
    assert.doesNotMatch(retry.commands, /^git push /m);
    assert.match(retry.commands, /^gh pr list /m);
    assert.match(retry.commands, /^gh pr create /m);

    const existing = await run({ MATCHING_BRANCH: '1', OPEN_PR: '123' });
    assert.equal(existing.status, 0, existing.stderr);
    assert.doesNotMatch(existing.commands, /^git push /m);
    assert.doesNotMatch(existing.commands, /^gh pr create /m);
    assert.match(existing.commands, /^gh pr edit 123 /m);
    assert.match(existing.commands, /--title fix\(registry\): re-pin rebuilt Neurocontainers images \(synthseg\) --body-file /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
