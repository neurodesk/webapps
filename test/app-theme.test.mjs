import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const css = await readFile(new URL('../site/app-theme.css', import.meta.url), 'utf8');

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing concrete --${name} token`);
  return match[1].toLowerCase();
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test('hosted theme uses the Neurocontainers Builder dark palette', () => {
  assert.equal(token('nd-brand-page'), '#0a0c08');
  assert.equal(token('nd-brand-primary'), '#91c84a');
  assert.equal(token('nd-brand-menu'), '#0a0c08');
  assert.equal(token('nd-brand-selection'), '#1f2e18');
  assert.equal(token('nd-brand-accent-background'), '#10140d');
  assert.equal(token('nd-brand-selected'), '#527435');
  assert.equal(token('nd-brand-hover'), '#a8d65c');
  assert.equal(token('nd-brand-unselected'), '#1f2e18');
  assert.equal(token('nd-brand-pale'), '#10140d');
  assert.equal(token('nd-brand-surface'), '#161a0e');
  assert.equal(token('nd-brand-text'), '#e8f5d0');
  assert.equal(token('nd-brand-border'), '#2d4222');
  assert.equal(token('nd-brand-success'), '#75b580');
});

test('core UI pairings meet WCAG AA text contrast', () => {
  assert.ok(contrast(token('nd-brand-text'), token('nd-brand-surface')) >= 4.5);
  assert.ok(contrast(token('nd-brand-text-muted'), token('nd-brand-surface')) >= 7);
  assert.ok(contrast(token('nd-brand-action-text'), token('nd-brand-primary')) >= 4.5);
  assert.ok(contrast(token('nd-brand-menu-text'), token('nd-brand-menu')) >= 4.5);
  assert.ok(contrast(token('nd-brand-light'), token('nd-brand-surface')) >= 4.5);
  assert.ok(contrast(token('nd-brand-text-dim'), token('nd-brand-pale')) >= 4.5);
  assert.ok(contrast(token('nd-brand-success'), token('nd-brand-surface')) >= 4.5);
  assert.ok(contrast(token('nd-brand-console-text'), token('nd-brand-console-surface')) >= 7);
  assert.ok(contrast(token('nd-brand-console-time'), token('nd-brand-console-surface')) >= 4.5);
});

test('disabled controls keep full opacity and readable text', () => {
  assert.match(css, /\[data-neurodesk-app\] :is\(button:disabled, input:disabled, select:disabled, textarea:disabled\)\s*\{[^}]*opacity:\s*1/s);
});

test('non-React legacy light roles are bridged into the shared dark palette', () => {
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-theme="dark"\]:not\(\[data-neurodesk-shell="react"\]\)\s*\{[^}]*--nd-brand-white:\s*var\(--nd-brand-surface\)/s);
  assert.match(css, /:is\(\.workflow-help, \.layer-list li, \.start-footer\)\s*\{[^}]*background:\s*var\(--nd-brand-pale\)/s);
  assert.match(css, /#controls\s+:is\(select, input\[type="text"\], input\[type="number"\]\)\s*\{[^}]*background:\s*var\(--nd-brand-unselected\)/s);
});

test('hosted apps expose the redesigned light palette as an explicit theme', () => {
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--nd-brand-page:\s*#f6f8f5[^}]*--nd-brand-primary:\s*#3f6f24[^}]*--nd-brand-text:\s*#18201b/s);
});

test('hosted apps use normal-width local UI typography', () => {
  assert.match(css, /--nd-font-ui:\s*system-ui/);
  assert.doesNotMatch(css, /Pontano Sans|Arial Narrow|fonts\.gstatic\.com/);
  assert.match(css, /font-stretch:\s*normal/);
});

test('light mode reserves green for meaning and uses blue keyboard focus', () => {
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-theme="light"\]\s*\{[^}]*--nd-brand-primary-hover:\s*#31591c[^}]*--nd-brand-unselected:\s*#f1f4f0[^}]*--nd-brand-border:\s*#dce2dc[^}]*--nd-brand-focus:\s*#2563a6/s);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--nd-brand-focus\)/s);
});

test('top-bar hosts keep their fallback content until the shared bar exists', () => {
  assert.match(css, /\[data-neurodesk-top-bar-host\]:has\(> \.nd-app-bar\)\s*>\s*:not\(\.nd-app-bar\)\s*\{[^}]*display:\s*none\s*!important/s);
  assert.doesNotMatch(css, /\[data-neurodesk-top-bar-host\]\s*>\s*:not\(\.nd-app-bar\)\s*\{[^}]*display:\s*none\s*!important/s);
});
