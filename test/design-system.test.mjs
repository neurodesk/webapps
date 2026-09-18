import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

// Design-system enforcement. The shared stylesheet in
// packages/components/src/styles/imaging-workspace.css is the only owner of
// sidebar, viewer, console, status and dialog styling for apps on the
// imaging-workspace shell. Coding agents drift by (1) hardcoding colours,
// (2) restyling the shared vocabulary in app CSS, and (3) hand-rolling
// pickers, buttons and dialogs. Each of those is a failing assertion here,
// with a ratchet for the apps that predate the vocabulary so the numbers can
// only go down.

const registry = await loadAppsRegistry();
const shellApps = registry.apps.filter((app) => app.shell === 'imaging-workspace');

// Apps that predate the vocabulary keep their current colour literal and CSS
// line counts as an upper bound. Migrating an app to the vocabulary removes it
// from this map; adding an app here is not allowed.
const LEGACY_CSS_RATCHET = new Map(Object.entries({
  browserqc: { colourLiterals: 0, cssLines: 72 },
  deface: { colourLiterals: 0, cssLines: 0 },
  niimath: { colourLiterals: 9, cssLines: 155 },
  surfannotate: { colourLiterals: 57, cssLines: 912 },
  zarro: { colourLiterals: 40, cssLines: 1223 },
}));

// What a vocabulary app may still put in its own stylesheet.
const VOCABULARY_CSS_BUDGET = { colourLiterals: 0, cssLines: 40 };

// Selectors only the shared stylesheet may define. Matching them in app CSS
// means the app is restyling the design language instead of extending it.
const RESERVED_SELECTORS = [
  /(^|[\s,{}])\.nd-(?!app-bar)[a-z-]+\s*[,{:>\s]/m, // any .nd-* class rule
  /(^|[\s,}])dialog\s*(\[|\.|,|\{|::backdrop)/m,
  /(^|[\s,}])summary\s*[,{:]/m,
  /(^|[\s,}])details\s*[,{:\[]/m,
  /(^|[\s,}])progress\s*[,{:]/m,
  /input\[type=["']?file["']?\]/m,
  /(^|[\s,}])\.(console|viewer|view|status|toolbar|section|sidebar|tabs?|btn|button|file|upload|drop|hint|modal)[a-z-]*\s*[,{:]/m,
];

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;

const SKIP_DIRECTORIES = new Set(['.git', '.turbo', 'coverage', 'dist', 'node_modules', 'test-results', 'vendor', 'public', 'e2e', 'test']);

async function collect(directory, extensions) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) files.push(...await collect(join(directory, entry.name), extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

async function appCss(app) {
  const root = join(repoRoot, 'apps', app.id);
  const files = await collect(root, ['.css']);
  const sources = await Promise.all(files.map(async (path) => ({ path: relative(repoRoot, path), text: await readFile(path, 'utf8') })));
  return sources.filter(({ text }) => !text.includes('/* upstream vendor stylesheet */'));
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function colourLiterals(css) {
  // Tokens are defined with literals in the shared theme, never in apps.
  return (stripComments(css).match(COLOUR_LITERAL) || []).length;
}

function lineCount(css) {
  return stripComments(css).split('\n').filter((line) => line.trim()).length;
}

test('every app on the imaging-workspace shell imports the shared workspace stylesheet', async () => {
  for (const app of shellApps) {
    const sources = await collect(join(repoRoot, 'apps', app.id), ['.js', '.ts', '.css', '.html']);
    const texts = await Promise.all(sources.map((path) => readFile(path, 'utf8')));
    assert.ok(texts.some((text) => /@neurodesk\/webapp-components\/styles\/imaging-workspace\.css|vendor\/webapp-components\/src\/styles\/imaging-workspace\.css/.test(text)),
      `${app.id}: import @neurodesk/webapp-components/styles/imaging-workspace.css`);
  }
});

test('vocabulary apps keep their own CSS token-only and within budget', async () => {
  const failures = [];
  for (const app of shellApps) {
    const ratchet = LEGACY_CSS_RATCHET.get(app.id);
    const sources = await appCss(app);
    const literals = sources.reduce((sum, { text }) => sum + colourLiterals(text), 0);
    const lines = sources.reduce((sum, { text }) => sum + lineCount(text), 0);
    const budget = ratchet || VOCABULARY_CSS_BUDGET;
    if (literals > budget.colourLiterals) failures.push(`${app.id}: ${literals} colour literals in app CSS (limit ${budget.colourLiterals}); use --nd-color-* tokens`);
    if (lines > budget.cssLines) failures.push(`${app.id}: ${lines} lines of app CSS (limit ${budget.cssLines}); move shared concerns into imaging-workspace.css`);
    if (ratchet && literals < ratchet.colourLiterals) failures.push(`${app.id}: colour literals fell to ${literals}; lower its LEGACY_CSS_RATCHET entry so the number cannot climb back`);
    if (ratchet && lines < ratchet.cssLines - 20) failures.push(`${app.id}: app CSS fell to ${lines} lines; lower its LEGACY_CSS_RATCHET entry`);
    if (!ratchet) {
      for (const { path, text } of sources) {
        for (const pattern of RESERVED_SELECTORS) {
          const match = stripComments(text).match(pattern);
          if (match) failures.push(`${path}: restyles the shared vocabulary (${match[0].trim()}); add the rule to imaging-workspace.css instead`);
        }
        if (/--nd-color-[a-z-]+\s*:/.test(stripComments(text))) failures.push(`${path}: overrides --nd-color-* tokens; the hosted theme owns colour`);
        if (/color-scheme\s*:/.test(stripComments(text))) failures.push(`${path}: forces color-scheme; the hosted theme owns light and dark`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('LEGACY_CSS_RATCHET only names apps that still exist on the shell', () => {
  const ids = new Set(shellApps.map((app) => app.id));
  for (const id of LEGACY_CSS_RATCHET.keys()) assert.ok(ids.has(id), `${id} is not an imaging-workspace app`);
});

// The markup contract for apps that have adopted the vocabulary. A new app
// scaffolded from the template satisfies all of these.
const VOCABULARY_APPS = shellApps.filter((app) => !LEGACY_CSS_RATCHET.has(app.id));

async function appHtml(app) {
  const candidates = ['index.html', 'src/index.html', 'web/index.html'];
  for (const candidate of candidates) {
    const path = join(repoRoot, 'apps', app.id, candidate);
    try { await stat(path); return { path: relative(repoRoot, path), html: await readFile(path, 'utf8') }; } catch { /* next */ }
  }
  throw new Error(`${app.id}: no index.html`);
}

test('vocabulary apps build their interface from the shared classes', async () => {
  const failures = [];
  for (const app of VOCABULARY_APPS) {
    const { path, html } = await appHtml(app);
    const check = (condition, message) => { if (!condition) failures.push(`${path}: ${message}`); };
    check(/<details class="nd-sidebar-section"[^>]*>\s*<summary class="nd-section-title">/.test(html), 'sidebar sections are details.nd-sidebar-section > summary.nd-section-title');
    check(!/<h[1-6][^>]*>/.test(html.replace(/<template[\s\S]*?<\/template>/g, '')), 'no free headings in the workspace; section titles are summaries');
    for (const input of html.matchAll(/<input[^>]*type="file"[^>]*>/g)) {
      const before = html.slice(Math.max(0, input.index - 160), input.index);
      check(/class="nd-file"/.test(before), `${input[0].slice(0, 60)}… must sit inside label.nd-file`);
      if (/data-neurodesk-input="image"/.test(input[0])) {
        check(/\bmultiple\b/.test(input[0]) && !/\baccept=/.test(input[0]), `${input[0].slice(0, 60)}… scan pickers are multiple with no accept filter`);
      }
    }
    check(/class="nd-btn nd-btn-primary"/.test(html), 'exactly the primary action uses .nd-btn.nd-btn-primary');
    check((html.match(/nd-btn-primary/g) || []).length === 1, 'one primary action per workspace');
    check(/<button[^>]*id="[^"]+"[^>]*hidden>(About|Cite|Privacy|Standalone)<\/button>/.test(html), 'About/Cite/Privacy buttons are hidden and registered through controlsContract');
    check(/class="nd-viewer-canvas-wrapper"/.test(html), 'viewer canvas sits in .nd-viewer-canvas-wrapper');
    check(/class="nd-viewer-empty"/.test(html), 'viewer has a .nd-viewer-empty message before import');
    check(/id="statusText"\s+class="nd-status-text"/.test(html) && /<progress\s/.test(html), 'status footer uses .nd-status-text and a native progress element');
    check(!/<dialog/.test(html), 'dialogs come from createInfoDialog(), not app markup');
    check(!/style="/.test(html), 'no inline styles');
    for (const button of html.matchAll(/<button[^>]*>/g)) {
      if (/hidden/.test(button[0])) continue;
      check(/class="nd-/.test(button[0]), `${button[0].slice(0, 60)}… buttons use nd-btn classes`);
    }
    const scripts = await collect(join(repoRoot, 'apps', app.id), ['.js', '.ts']);
    const source = (await Promise.all(scripts.map((file) => readFile(file, 'utf8')))).join('\n');
    check(/createConsole\(/.test(source), 'technical log comes from createConsole()');
    check(/createInfoDialog\(/.test(source), 'information dialogs come from createInfoDialog()');
    check(/createViewerToolbar\(/.test(source), 'viewer toolbar comes from createViewerToolbar()');
  }
  assert.deepEqual(failures, []);
});

test('the app template is the canonical vocabulary example', async () => {
  const template = join(repoRoot, 'templates', 'app-template');
  const html = await readFile(join(template, 'index.html'), 'utf8');
  for (const marker of ['class="nd-sidebar-section"', 'class="nd-file"', 'nd-btn nd-btn-primary', 'class="nd-viewer-canvas-wrapper"', 'class="nd-status-text"']) {
    assert.ok(html.includes(marker), `template lacks ${marker}`);
  }
  const main = await readFile(join(template, 'src', 'main.js'), 'utf8');
  for (const call of ['createViewerToolbar(', 'createConsole(', 'createInfoDialog(', 'bindFileDrop(']) assert.ok(main.includes(call), `template lacks ${call}`);
});

test('the shared stylesheet defines the whole vocabulary the template and docs rely on', async () => {
  const css = await readFile(join(repoRoot, 'packages', 'components', 'src', 'styles', 'imaging-workspace.css'), 'utf8');
  for (const selector of [
    '.nd-sidebar-section', '.nd-section-title', '.nd-section-content', '.nd-field', '.nd-hint', '.nd-check', '.nd-row',
    '.nd-file', '.nd-file-info', '.nd-btn', '.nd-btn-primary', '.nd-btn-secondary', '.nd-btn-sm', '.nd-btn-icon',
    '.nd-message', '.nd-info-icon', '.nd-info-tooltip', '.nd-viewer-toolbar', '.nd-view-tabs', '.nd-view-tab', '.nd-viewer-actions',
    '.nd-viewer-canvas-wrapper', '.nd-viewer-empty', '.nd-viewer-info', '.nd-console-container', '.nd-console-title', '.nd-console-output',
    '.nd-status-label', '.nd-status-text', 'dialog.nd-dialog', '.nd-dialog-header', '.nd-dialog-body', '.nd-command', '.nd-volume-toggle', '.nd-result-visibility',
  ]) {
    assert.ok(css.includes(selector), `imaging-workspace.css must define ${selector}`);
  }
});
