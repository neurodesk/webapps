import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// TypeScript and checkJs projects whose sources receive the type-aware promise rules.
// Each `sources` entry is a directory (trailing `/`, every matched source below it) or
// one file. Those sources are linted against `tsconfig`, which the pinned
// TypeScript 5 compiler must accept first. See docs/development/correctness-lint.md.
export const typedPromiseProjects = [
  { name: 'zarro', sources: ['apps/zarro/src/'], tsconfig: 'apps/zarro/tsconfig.json' },
  { name: 'deface', sources: ['apps/deface/src/'], tsconfig: 'apps/deface/tsconfig.json' },
  { name: 'browserqc', sources: ['apps/browserqc/src/'], tsconfig: 'apps/browserqc/tsconfig.json' },
  { name: 'dwi2trx', sources: ['apps/dwi2trx/src/'], tsconfig: 'apps/dwi2trx/tsconfig.json' },
  {
    name: 'agentic',
    sources: ['test/agentic/', 'test-utils/agentic-browser.ts', 'e2e.config.ts'],
    tsconfig: 'tsconfig.agentic.json',
  },
  { name: 'dicompare', sources: ['apps/dicompare/src/'], tsconfig: 'apps/dicompare/tsconfig.json' },
  {
    name: 'components-automation',
    sources: ['packages/components/src/automation/'],
    tsconfig: 'packages/components/tsconfig.automation-lint.json',
    includeJs: true,
  },
];

export const promiseRules = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/no-misused-promises'];

const typescriptSource = /\.[cm]?tsx?$/;
const javascriptOrTypescriptSource = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

export function typedProjectFor(file) {
  return typedPromiseProjects.find((project) => {
    const pattern = project.includeJs ? javascriptOrTypescriptSource : typescriptSource;
    if (!pattern.test(file)) return false;
    return project.sources.some((source) => source.endsWith('/') ? file.startsWith(source) : file === source);
  });
}

// ESLint `files` patterns covering the same sources as typedProjectFor.
export function typedSourceGlobs({ sources, includeJs }) {
  const extensions = includeJs ? '{js,mjs,cjs,jsx,ts,tsx,mts,cts}' : '{ts,tsx,mts,cts}';
  return sources.map((source) => source.endsWith('/') ? `${source}**/*.${extensions}` : source);
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
