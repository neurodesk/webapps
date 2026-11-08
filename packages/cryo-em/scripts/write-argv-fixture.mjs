#!/usr/bin/env node
// Writes test/fixtures/argv-cases.json: each GUI case's spec, parts, profile
// and directory with the command this package generates for it. The Rust
// server's tests read the file and must produce the same commands byte for
// byte. Run after changing src/commands.json, src/spec.js or test/gui-cases.js.

import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relionCommand, validateRelionSpec } from '../src/spec.js';
import { GUI_CASES } from '../test/gui-cases.js';

export function argvCases() {
  return GUI_CASES.map(testCase => {
    const parts = testCase.parts ?? [];
    const validated = validateRelionSpec(testCase.spec, { parts, profile: testCase.profile });
    return {
      name: testCase.name,
      spec: testCase.spec,
      parts,
      profile: testCase.profile,
      directory: testCase.directory,
      expected: relionCommand(validated, { directory: testCase.directory, profile: testCase.profile }),
    };
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const target = new URL('../test/fixtures/argv-cases.json', import.meta.url);
  await writeFile(target, `${JSON.stringify(argvCases(), null, 2)}\n`);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
