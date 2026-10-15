import { runBrowserTests } from './playwright-build.mjs';

if (process.argv.length !== 3) throw new Error('Expected one browser test command');
process.exitCode = runBrowserTests(process.argv[2]);
