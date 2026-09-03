import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../site/landing.css', import.meta.url), 'utf8');

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing concrete --${name} token`);
  return match[1].toLowerCase();
}

test('landing page uses the Neurocontainers Builder dark palette', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark/s);
  assert.equal(token('page'), '#0a0c08');
  assert.equal(token('surface'), '#10140d');
  assert.equal(token('white'), '#161a0e');
  assert.equal(token('text'), '#e8f5d0');
  assert.equal(token('muted'), '#9ca3af');
  assert.equal(token('green'), '#91c84a');
  assert.equal(token('line'), '#2d4222');
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--page\)/s);
});

test('landing page exposes a neutral, readable light palette', () => {
  assert.match(css, /:root\[data-neurodesk-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--page:\s*#f6f8f5[^}]*--green:\s*#3f6f24[^}]*--text:\s*#18201b[^}]*--surface:\s*#f1f4f0/s);
  assert.doesNotMatch(css, /Pontano Sans|Arial Narrow|fonts\.gstatic\.com/);
});
