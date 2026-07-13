'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/**
 * Load one of SCT's browser/Node UMD scripts as CommonJS even though the app
 * package is ESM. Browser execution is unchanged; Node contract tests receive
 * the same `module.exports` object they used before the monorepo added
 * `type: module` to the workspace package.
 */
module.exports = function loadClassicScript(filename) {
  const absolute = path.resolve(filename);
  const source = fs.readFileSync(absolute, 'utf8');
  const classicModule = { exports: {} };
  const localRequire = createRequire(absolute);
  const execute = new Function(
    'module',
    'exports',
    'require',
    '__filename',
    '__dirname',
    `${source}\n//# sourceURL=${absolute}`
  );
  execute(classicModule, classicModule.exports, localRequire, absolute, path.dirname(absolute));
  return classicModule.exports;
};
