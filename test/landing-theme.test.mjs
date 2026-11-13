import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../site/landing.css', import.meta.url), 'utf8');

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing concrete --${name} token`);
  return match[1].toLowerCase();
}

test('landing page matches the app theme: neutral greys and the logo green', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark/s);
  assert.equal(token('page'), '#0d0e0d');
  assert.equal(token('surface'), '#141514');
  assert.equal(token('white'), '#1c1d1c');
  assert.equal(token('text'), '#ededed');
  assert.equal(token('muted'), '#8c8f8c');
  assert.equal(token('accent'), '#6ba442');
  assert.equal(token('line'), '#262826');
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--page\)/s);
});

function luminance(hex) {
  const linear = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('small muted labels on the green panels meet AA contrast', () => {
  // Analytics labels and the search shortcut sit on --accent-pale.
  for (const fg of ['muted', 'accent-dark']) assert.ok(contrast(token(fg), token('accent-pale')) >= 4.5, fg);
});

test('landing page exposes a neutral, readable light palette', () => {
  assert.match(css, /:root\[data-neurodesk-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--page:\s*#fafafa[^}]*--accent:\s*#467d25[^}]*--text:\s*#171817[^}]*--surface:\s*#f4f4f5/s);
  assert.doesNotMatch(css, /Pontano Sans|Arial Narrow|fonts\.gstatic\.com/);
});

function scigetToken(name, mode) {
  const selector = mode === 'light'
    ? /:root\[data-neurodesk-brand="sciget"\]\[data-neurodesk-theme="light"\]\s*\{([^}]*)\}/
    : /:root\[data-neurodesk-brand="sciget"\]\s*\{([^}]*)\}/;
  const block = css.match(selector);
  assert.ok(block, `missing the SciGet ${mode} landing palette`);
  const match = block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `the SciGet ${mode} landing palette must restate --${name}`);
  return match[1].toLowerCase();
}

test('SciGet catalogues and hub follow sciget.org: orange accent, its greys, readable text', () => {
  assert.equal(scigetToken('accent', 'dark'), '#d97706');
  assert.equal(scigetToken('page', 'dark'), '#17181c');
  assert.equal(scigetToken('header', 'dark'), '#23262f');
  assert.equal(scigetToken('accent', 'light'), '#b85c00');
  assert.equal(scigetToken('page', 'light'), '#ffffff');
  assert.match(css, /:root\[data-neurodesk-brand="sciget"\]\s*\{[^}]*font-family:\s*-apple-system/);
  const pairs = [
    ['text', 'page'], ['text', 'white'], ['muted', 'white'], ['hero-muted', 'hero'],
    ['header-text', 'header'], ['on-accent', 'accent'], ['muted', 'accent-pale'],
    ['accent-dark', 'accent-pale'], ['accent-light', 'header'], ['ink', 'white'],
  ];
  for (const mode of ['dark', 'light']) {
    for (const [foreground, background] of pairs) {
      const ratio = contrast(scigetToken(foreground, mode), scigetToken(background, mode));
      assert.ok(ratio >= 4.5, `SciGet ${mode} --${foreground} on --${background}: ${ratio.toFixed(2)} < 4.5`);
    }
  }
});
