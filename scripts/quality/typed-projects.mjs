import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// TypeScript projects whose sources receive the type-aware promise rules.
// Each `sources` entry is a directory (trailing `/`, every TS source below it) or
// one file. Those sources are linted against `tsconfig`, which the pinned
// TypeScript 5 compiler must accept first. See docs/development/correctness-lint.md.
export const typedPromiseProjects = [
  { name: 'zarro', sources: ['apps/zarro/src/'], tsconfig: 'apps/zarro/tsconfig.json' },
  { name: 'deface', sources: ['apps/deface/src/'], tsconfig: 'apps/deface/tsconfig.json' },
  { name: 'dwi2trx', sources: ['apps/dwi2trx/src/'], tsconfig: 'apps/dwi2trx/tsconfig.json' },
  {
    name: 'agentic',
    sources: ['test/agentic/', 'test-utils/agentic-browser.ts', 'e2e.config.ts'],
    tsconfig: 'tsconfig.agentic.json',
  },
  { name: 'dicompare', sources: ['apps/dicompare/src/'], tsconfig: 'apps/dicompare/tsconfig.json' },
];

export const promiseRules = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/no-misused-promises'];

const typescriptSource = /\.[cm]?tsx?$/;

export function typedProjectFor(file) {
  if (!typescriptSource.test(file)) return undefined;
  return typedPromiseProjects.find(({ sources }) => sources.some((source) => source.endsWith('/') ? file.startsWith(source) : file === source));
}

// ESLint `files` patterns covering the same sources as typedProjectFor.
export function typedSourceGlobs({ sources }) {
  return sources.map((source) => source.endsWith('/') ? `${source}**/*.{ts,tsx,mts,cts}` : source);
}

// The lint parser does not report semantic errors: an unresolved import becomes
// `any` and hides its promises. Compile each project with the parser's compiler.
export function assertTypedProjectsCompile(cwd, files) {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  for (const project of typedPromiseProjects) {
    if (!files.some((file) => typedProjectFor(file) === project)) continue;
    try {
      execFileSync(process.execPath, [tsc, '-p', project.tsconfig, '--noEmit', '--pretty', 'false'], { cwd, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message;
      throw new Error(`${project.tsconfig} does not compile; promise lint needs its type information.\n${output}`);
    }
  }
}
