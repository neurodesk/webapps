import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export async function isolatedLintRepository(source) {
  const root = await mkdtemp(join(tmpdir(), 'lint-repository-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    for (const file of new Set(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      try {
        await copyFile(join(source, file), join(root, file), constants.COPYFILE_FICLONE);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    // Reuse installed dependencies; all owned source and generated canaries stay in the copy.
    const parents = new Set(['.', ...files.filter(file => file.endsWith('/package.json')).map(dirname)]);
    for (const parent of parents) {
      const modules = resolve(source, parent, 'node_modules');
      try {
        await access(modules);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await symlink(modules, join(root, parent, 'node_modules'), 'junction');
    }
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '--all'], { cwd: root });
    return { root, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
