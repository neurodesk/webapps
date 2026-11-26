import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Linter } from 'eslint';
import {
  WORKFLOW_STARTUP_HEADROOM_MS,
  resolveAppTimeoutMs,
} from '../scripts/desktop/smoke-timeouts.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const linter = new Linter();

function parseModuleAst(source, context) {
  let ast = null;
  const messages = linter.verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: {
      budgetAst: {
        rules: {
          capture: {
            create(ruleContext) {
              ast = ruleContext.sourceCode.ast;
              return {};
            },
          },
        },
      },
    },
    rules: { 'budgetAst/capture': 'error' },
  });
  const parseErrors = messages.filter(message => message.fatal);
  if (parseErrors.length || !ast) {
    throw new Error(`Failed to parse ${context}: ${parseErrors[0]?.message ?? 'no AST'}`);
  }
  return ast;
}

function isProcessEnvMember(node) {
  return (
    node?.type === 'MemberExpression'
    && !node.computed
    && node.object?.type === 'MemberExpression'
    && !node.object.computed
    && node.object.object?.type === 'Identifier'
    && node.object.object.name === 'process'
    && node.object.property?.type === 'Identifier'
    && node.object.property.name === 'env'
    && node.property?.type === 'Identifier'
  );
}

function extractParamDefaults(params) {
  const defaults = new Map();
  for (const param of params ?? []) {
    if (param.type === 'AssignmentPattern') {
      if (param.left.type === 'Identifier') {
        defaults.set(param.left.name, param.right);
      } else if (param.left.type === 'ObjectPattern') {
        for (const prop of param.left.properties) {
          if (prop.type === 'Property' && prop.value?.type === 'AssignmentPattern' && prop.value.left?.type === 'Identifier') {
            defaults.set(prop.value.left.name, prop.value.right);
          }
        }
      }
    } else if (param.type === 'ObjectPattern') {
      for (const prop of param.properties) {
        if (prop.type === 'Property' && prop.value?.type === 'AssignmentPattern' && prop.value.left?.type === 'Identifier') {
          defaults.set(prop.value.left.name, prop.value.right);
        }
      }
    }
  }
  return defaults;
}

function evaluateTimeoutNode(node, source, context, paramDefaults = new Map()) {
  if (node?.type === 'Literal' && typeof node.value === 'number' && Number.isFinite(node.value) && node.value > 0) {
    return node.value;
  }
  if (node?.type === 'Identifier' && paramDefaults.has(node.name)) {
    return evaluateTimeoutNode(paramDefaults.get(node.name), source, context);
  }
  if (node?.type === 'BinaryExpression' && node.operator === '*') {
    return (
      evaluateTimeoutNode(node.left, source, context, paramDefaults)
      * evaluateTimeoutNode(node.right, source, context, paramDefaults)
    );
  }
  if (
    node?.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && node.callee.name === 'Number'
    && node.arguments.length === 1
    && node.arguments[0]?.type === 'LogicalExpression'
    && node.arguments[0].operator === '||'
    && isProcessEnvMember(node.arguments[0].left)
  ) {
    return evaluateTimeoutNode(node.arguments[0].right, source, context, paramDefaults);
  }
  const snippet = node?.range ? source.slice(node.range[0], node.range[1]).trim() : String(node?.type);
  throw new Error(`Unsupported timeout expression "${snippet}" in ${context}`);
}

function propertyKeyName(prop) {
  if (prop.type !== 'Property' || prop.kind !== 'init') return null;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  if (prop.key.type === 'TemplateLiteral' && prop.key.expressions.length === 0) {
    return prop.key.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

function sumNodeBudgetMs(node, source, context, helperBudgets = new Map(), paramDefaults = new Map()) {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    let total = 0;
    for (const item of node) total += sumNodeBudgetMs(item, source, context, helperBudgets, paramDefaults);
    return total;
  }

  if (node.type === 'ForOfStatement') {
    const bodyMs = sumNodeBudgetMs(node.body, source, context, helperBudgets, paramDefaults);
    if (bodyMs === 0) return 0;
    if (node.right?.type !== 'ArrayExpression') {
      const snippet = node.right?.range ? source.slice(node.right.range[0], node.right.range[1]).trim() : node.right?.type;
      throw new Error(`Unsupported dynamic loop iterable "${snippet}" containing waits/downloads in ${context}`);
    }
    if (node.right.elements.length === 0) {
      throw new Error(`Empty loop iterable containing waits/downloads in ${context}`);
    }
    for (const element of node.right.elements) {
      if (!element || element.type === 'SpreadElement') {
        throw new Error(`Unsupported spread or sparse element in loop iterable containing waits/downloads in ${context}`);
      }
    }
    return node.right.elements.length * bodyMs;
  }

  if (
    node.type === 'ForStatement'
    || node.type === 'ForInStatement'
    || node.type === 'WhileStatement'
    || node.type === 'DoWhileStatement'
  ) {
    const bodyMs = sumNodeBudgetMs(node.body, source, context, helperBudgets, paramDefaults);
    if (bodyMs > 0) {
      throw new Error(`Unsupported ${node.type} containing waits/downloads in ${context}`);
    }
    return 0;
  }

  let total = 0;

  if (node.type === 'Property' && propertyKeyName(node) === 'timeout') {
    return evaluateTimeoutNode(node.value, source, context, paramDefaults);
  }

  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && helperBudgets.has(node.callee.name)) {
    total += helperBudgets.get(node.callee.name);
  }

  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.property?.type === 'Identifier'
    && node.callee.property.name === 'waitForTimeout'
    && node.arguments.length >= 1
  ) {
    total += evaluateTimeoutNode(node.arguments[0], source, context, paramDefaults);
  }

  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && node.callee.name === 'setTimeout'
    && node.arguments.length >= 2
  ) {
    total += evaluateTimeoutNode(node.arguments[1], source, context, paramDefaults);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
    if (value && typeof value === 'object') {
      total += sumNodeBudgetMs(value, source, context, helperBudgets, paramDefaults);
    }
  }
  return total;
}

function sumSourceBudgetMs(source, context, helperBudgets = new Map()) {
  const ast = parseModuleAst(source, context);
  return sumNodeBudgetMs(ast, source, context, helperBudgets);
}

function extractExportedFunctionBudgetMs(source, fnName, context, helperBudgets = new Map()) {
  const ast = parseModuleAst(source, context);
  const exported = ast.body.find(
    node => node.type === 'ExportNamedDeclaration'
      && node.declaration?.type === 'FunctionDeclaration'
      && node.declaration.id?.name === fnName,
  );
  assert.ok(exported, `expected exported function ${fnName} in ${context}`);
  const paramDefaults = extractParamDefaults(exported.declaration.params);
  return sumNodeBudgetMs(exported.declaration.body, source, context, helperBudgets, paramDefaults);
}

function matchedBranchAppIds(testNode) {
  if (
    testNode?.type === 'BinaryExpression'
    && testNode.operator === '==='
    && testNode.left?.type === 'Identifier'
    && testNode.left.name === 'id'
    && testNode.right?.type === 'Literal'
    && typeof testNode.right.value === 'string'
  ) {
    return [testNode.right.value];
  }
  if (
    testNode?.type === 'CallExpression'
    && testNode.callee?.type === 'MemberExpression'
    && !testNode.callee.computed
    && testNode.callee.property?.type === 'Identifier'
    && testNode.callee.property.name === 'includes'
    && testNode.callee.object?.type === 'ArrayExpression'
    && testNode.arguments.length === 1
    && testNode.arguments[0]?.type === 'Identifier'
    && testNode.arguments[0].name === 'id'
  ) {
    return testNode.callee.object.elements
      .filter(element => element?.type === 'Literal' && typeof element.value === 'string')
      .map(element => element.value);
  }
  return null;
}

function extractInlineWorkflowBudgets(workflowsSource, importedHelperBudgets = new Map()) {
  const ast = parseModuleAst(workflowsSource, 'scripts/desktop/workflows.mjs');
  const handoffFn = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'verifyLesionHandoff');
  const verifyExport = ast.body.find(
    node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'verifyWorkflow',
  );
  assert.ok(handoffFn && verifyExport, 'expected verifyLesionHandoff and verifyWorkflow declarations');

  const downloadDeclarator = verifyExport.declaration.body.body
    .filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations)
    .find(decl => decl.id?.type === 'Identifier' && decl.id.name === 'download');
  assert.ok(downloadDeclarator?.init, 'expected const download helper inside verifyWorkflow');
  const downloadBudgetMs = sumNodeBudgetMs(
    downloadDeclarator.init,
    workflowsSource,
    'scripts/desktop/workflows.mjs (download)',
  );
  assert.ok(downloadBudgetMs > 0, 'download helper must declare a positive wait timeout');

  const handoffBudgetMs = sumNodeBudgetMs(
    handoffFn.body,
    workflowsSource,
    'scripts/desktop/workflows.mjs (verifyLesionHandoff)',
  );
  const helperBudgets = new Map([
    ['download', downloadBudgetMs],
    ['verifyLesionHandoff', handoffBudgetMs],
    ...importedHelperBudgets,
  ]);

  const perApp = new Map();
  for (const statement of verifyExport.declaration.body.body) {
    if (statement.type !== 'IfStatement') continue;
    const ids = matchedBranchAppIds(statement.test);
    if (!ids?.length) continue;
    const budgetMs = sumNodeBudgetMs(
      statement.consequent,
      workflowsSource,
      `scripts/desktop/workflows.mjs (${ids.join(', ')})`,
      helperBudgets,
    );
    for (const id of ids) {
      perApp.set(id, (perApp.get(id) ?? 0) + budgetMs);
    }
  }
  return { perApp, downloadBudgetMs };
}

test('AST budget parser handles quoted/commented/multiline timeout properties and rejects unsupported expressions', () => {
  assert.equal(sumSourceBudgetMs(`await expect(p).toBeEnabled({ 'timeout': 30 * 60 * 1000 });`, 'quoted'), 1_800_000);
  assert.equal(sumSourceBudgetMs(`await expect(p).toBeEnabled({ "timeout": 900_000 });`, 'double-quoted'), 900_000);
  assert.equal(sumSourceBudgetMs(`await expect(p).toBeEnabled({ ['timeout']: 30 * 60 * 1000 });`, 'computed-literal'), 1_800_000);
  assert.equal(sumSourceBudgetMs(`await expect(p).toBeEnabled({ timeout /* note */: 30 * 60 * 1000 });`, 'commented'), 1_800_000);
  assert.equal(
    sumSourceBudgetMs(`await expect(p).toBeEnabled({ timeout: Number(process.env.SYNCRO_AUTOMATION_TIMEOUT_MS || 1_800_000) });`, 'env-default'),
    1_800_000,
  );
  assert.equal(
    sumSourceBudgetMs(`await expect(p).toBeEnabled({\n  timeout: 30\n    * 60\n    * 1000,\n});`, 'multiline-product'),
    1_800_000,
  );
  assert.throws(
    () => sumSourceBudgetMs(`await expect(p).toBeEnabled({\n  timeout: 120_000\n    + 1_800_000\n});`, 'multiline-addition'),
    /Unsupported timeout expression/,
  );
  assert.throws(
    () => sumSourceBudgetMs(`await expect(p).toBeEnabled({ timeout: CUSTOM_TIMEOUT_MS });`, 'named-const'),
    /Unsupported timeout expression/,
  );
});

test('AST budget parser multiplies static loops and rejects spreads, dynamic iterables, and unbraced loops', () => {
  const synthetic = `
    await expect(page.locator('#example')).toBeEnabled({ timeout: 2 * 60 * 1000 });
    await expect(page.locator('#ready')).toHaveAttribute('data-state', 'ready', { timeout: 300_000 });
    for (const selector of ['#a', '#b', '#c']) {
      await expect(page.locator(selector)).toBeEnabled({ timeout: 60_000 });
    }
    await expect(page.locator('#statusText')).toContainText('done', { timeout: 30 * 60 * 1000 });
    for (const [label, file] of [['One', 'a.nii'], ['Two', 'b.nii'], ['Three', 'c.nii'], ['Four', 'd.nii']]) {
      await download(label);
    }
    await download('#zip');
    await helperStep();
  `;
  const total = sumSourceBudgetMs(synthetic, 'synthetic', new Map([['download', 60_000], ['helperStep', 180_000]]));
  assert.equal(total, (2 + 5 + 3 + 30 + 4 + 1 + 3) * 60 * 1000);

  assert.throws(
    () => sumSourceBudgetMs(`for (const s of ['#a', ...extra]) { await expect(p).toBeEnabled({ timeout: 60_000 }); }`, 'spread-loop'),
    /Unsupported spread/,
  );
  assert.throws(
    () => sumSourceBudgetMs(`for (const s of selectors) await expect(p).toBeEnabled({ timeout: 60_000 });`, 'unbraced-dynamic-loop'),
    /Unsupported dynamic loop iterable/,
  );
  assert.throws(
    () => sumSourceBudgetMs(`while (pending) await download('#out');`, 'unbraced-while', new Map([['download', 60_000]])),
    /Unsupported WhileStatement/,
  );
  assert.throws(
    () => sumSourceBudgetMs(`for (let i = 0; i < count; i += 1) await download('#out');`, 'for-counter', new Map([['download', 60_000]])),
    /Unsupported ForStatement/,
  );
});

test('download budget is derived from workflows.mjs rather than hardcoded', async () => {
  const workflowsSource = await readFile(join(repoRoot, 'scripts/desktop/workflows.mjs'), 'utf8');
  const mutatedSource = workflowsSource.replace(
    "globalThis.neurodeskOffline.downloads[count]?.state, count), { timeout: 60000 }",
    "globalThis.neurodeskOffline.downloads[count]?.state, count), { timeout: 300000 }",
  );
  assert.notEqual(mutatedSource, workflowsSource, 'expected download helper wait to be mutated');
  const { perApp, downloadBudgetMs } = extractInlineWorkflowBudgets(mutatedSource);
  assert.equal(downloadBudgetMs, 300_000);
  assert.equal(perApp.get('fastprep'), 41 * 60 * 1000);
});

test('every offline workflow sequential budget fits inside resolveAppTimeoutMs with startup headroom', async () => {
  const workflowsSource = await readFile(join(repoRoot, 'scripts/desktop/workflows.mjs'), 'utf8');
  assert.doesNotMatch(workflowsSource, /#brainExtractor/, 'SYNcro desktop workflow must use #mindgrabBackend, not removed #brainExtractor');
  assert.match(workflowsSource, /#mindgrabBackend/);

  const musclemapSource = await readFile(join(repoRoot, 'test/musclemap-full-pipeline-smoke.mjs'), 'utf8');
  const musclemapBudgetMs = extractExportedFunctionBudgetMs(
    musclemapSource,
    'verifyMuscleMapFullPipeline',
    'test/musclemap-full-pipeline-smoke.mjs',
  );
  assert.equal(musclemapBudgetMs, 7 * 60 * 1000, 'MuscleMap helper budget must include navigation, readiness, 3m inference, and metrics waits');

  const { perApp: budgets, downloadBudgetMs } = extractInlineWorkflowBudgets(
    workflowsSource,
    new Map([['verifyMuscleMapFullPipeline', musclemapBudgetMs]]),
  );
  assert.equal(downloadBudgetMs, 60_000);
  assert.equal(budgets.get('fastprep'), 37 * 60 * 1000, 'fastprep must include shared example, runButton, run, and download budgets');
  assert.equal(budgets.get('white-matter-lesions'), 27 * 60 * 1000);
  assert.equal(budgets.get('syncro'), 32 * 60 * 1000);
  assert.equal(budgets.get('dicomview'), 20 * 60 * 1000 + 1_500, 'dicomview must include verifyLesionHandoff waits and waitForTimeout(1500)');
  assert.equal(budgets.get('dicompare'), 120_000, 'dicompare must include setTimeout worker deadline');
  assert.equal(budgets.get('me-ica'), 14 * 60 * 1000, 'me-ica must multiply its 4 loop downloads plus archive download');
  assert.equal(budgets.get('vesselboost'), 14 * 60 * 1000, 'vesselboost must multiply its 3 skip-button readiness waits');
  assert.equal(budgets.get('musclemap'), 7 * 60 * 1000, 'musclemap must include imported verifyMuscleMapFullPipeline budget');

  const offlineHelpers = new Map([['download', downloadBudgetMs]]);
  const appsDir = join(repoRoot, 'apps');
  let checkedOfflineModules = 0;
  for (const entry of await readdir(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const offlinePath = join(appsDir, entry.name, 'test/offline.mjs');
    let source;
    try {
      source = await readFile(offlinePath, 'utf8');
    } catch {
      continue;
    }
    checkedOfflineModules += 1;
    const moduleBudgetMs = sumSourceBudgetMs(source, offlinePath, offlineHelpers);
    budgets.set(entry.name, (budgets.get(entry.name) ?? 0) + moduleBudgetMs);
  }
  assert.ok(checkedOfflineModules >= 20, `expected to inspect app offline.mjs modules, found ${checkedOfflineModules}`);
  assert.equal(budgets.get('samsrf'), 36 * 60 * 1000, 'samsrf must include example load, run, and download budgets');

  for (const [appId, sequentialBudgetMs] of budgets) {
    const outerMs = resolveAppTimeoutMs(appId, { workflows: true });
    assert.ok(
      outerMs >= sequentialBudgetMs + WORKFLOW_STARTUP_HEADROOM_MS,
      `${appId}: outer smoke timeout (${outerMs}ms) must be >= sequential workflow budget (${sequentialBudgetMs}ms) + startup headroom (${WORKFLOW_STARTUP_HEADROOM_MS}ms)`,
    );
  }
});
