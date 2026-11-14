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

test('hosted theme is neutral grey with the Neurodesk logo green as its accent', () => {
  assert.equal(token('nd-brand-primary'), '#6ba442');
  assert.equal(token('nd-brand-page'), '#0d0e0d');
  assert.equal(token('nd-brand-surface'), '#141514');
  assert.equal(token('nd-brand-unselected'), '#1c1d1c');
  assert.equal(token('nd-brand-border'), '#262826');
  assert.equal(token('nd-brand-text'), '#ededed');
  assert.equal(token('nd-brand-focus'), '#6ba442');
});

test('core UI pairings meet WCAG AA text contrast', () => {
  assert.ok(contrast(token('nd-brand-text'), token('nd-brand-surface')) >= 4.5);
  assert.ok(contrast(token('nd-brand-text-muted'), token('nd-brand-surface')) >= 7);
  assert.ok(contrast(token('nd-brand-action-text'), token('nd-brand-primary')) >= 4.5);
  assert.ok(contrast(token('nd-brand-menu-text'), token('nd-brand-menu')) >= 4.5);
  // The app title in the bar is primary green.
  assert.ok(contrast(token('nd-brand-primary'), token('nd-brand-menu')) >= 4.5);
  assert.ok(contrast(token('nd-brand-light'), token('nd-brand-surface')) >= 4.5);
  assert.ok(contrast(token('nd-brand-text-dim'), token('nd-brand-pale')) >= 4.5);
  assert.ok(contrast(token('nd-brand-success'), token('nd-brand-surface')) >= 4.5);
  assert.ok(contrast(token('nd-brand-console-text'), token('nd-brand-console-surface')) >= 7);
  assert.ok(contrast(token('nd-brand-console-time'), token('nd-brand-console-surface')) >= 4.5);
});

// The light palette overrides a subset of the brand tokens in its own block; a token
// it does not restate keeps its dark value, exactly as the cascade resolves it.
function lightToken(name) {
  const block = css.match(/:root\[data-neurodesk-app\]\[data-neurodesk-theme="light"\]\s*\{([^}]*)\}/);
  assert.ok(block, 'missing the light palette block');
  const match = block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  return match ? match[1].toLowerCase() : token(name);
}

test('the light palette meets the same WCAG AA text contrast', () => {
  const pairs = [
    ['nd-brand-text', 'nd-brand-surface', 4.5],
    ['nd-brand-text-muted', 'nd-brand-surface', 4.5],
    ['nd-brand-action-text', 'nd-brand-primary', 4.5],
    ['nd-brand-menu-text', 'nd-brand-menu', 4.5],
    ['nd-brand-primary', 'nd-brand-menu', 4.5],
    ['nd-brand-text-dim', 'nd-brand-pale', 4.5],
    ['nd-brand-success', 'nd-brand-surface', 4.5],
    ['nd-brand-console-text', 'nd-brand-console-surface', 4.5],
    ['nd-brand-console-time', 'nd-brand-console-surface', 4.5],
  ];
  assert.notEqual(lightToken('nd-brand-surface'), token('nd-brand-surface'), 'the light palette must define its own surface');
  for (const [foreground, background, minimum] of pairs) {
    const ratio = contrast(lightToken(foreground), lightToken(background));
    assert.ok(ratio >= minimum, `light ${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
  }
});

test('the contrast formula reproduces the WCAG reference ratios', () => {
  // WCAG 2.1: black on white is 21:1; #767676 is the lightest grey that passes AA on white.
  assert.equal(Number(contrast('#000000', '#ffffff').toFixed(2)), 21);
  assert.equal(Number(contrast('#767676', '#ffffff').toFixed(2)), 4.54);
  assert.equal(Number(contrast('#777777', '#ffffff').toFixed(2)), 4.48);
});

test('disabled controls keep full opacity and readable text', () => {
  assert.match(css, /\[data-neurodesk-app\] :is\(button:disabled, input:disabled, select:disabled, textarea:disabled\)\s*\{[^}]*opacity:\s*1/s);
});

test('non-React legacy light roles are bridged into the shared dark palette', () => {
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-theme="dark"\]:not\(\[data-neurodesk-shell="react"\]\)\s*\{[^}]*--nd-brand-white:\s*var\(--nd-brand-surface\)/s);
  assert.match(css, /:is\(\.workflow-help, \.layer-list li, \.start-footer\)\s*\{[^}]*background:\s*var\(--nd-brand-pale\)/s);
  assert.match(css, /#controls\s+:is\(select, input\[type="text"\], input\[type="number"\]\)\s*\{[^}]*background-color:\s*var\(--nd-brand-page\)/s);
});

test('hosted apps expose the redesigned light palette as an explicit theme', () => {
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-theme="light"\]\s*\{[^}]*color-scheme:\s*light[^}]*--nd-brand-page:\s*#fafafa[^}]*--nd-brand-primary:\s*#467d25[^}]*--nd-brand-text:\s*#171817/s);
});

test('hosted apps use Inter, served with the theme, and normal-width type', () => {
  assert.match(css, /--nd-font-ui:\s*"Inter Variable", system-ui/);
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*"Inter Variable"[^}]*src:\s*url\("fonts\/inter\.woff2"\)/s);
  assert.doesNotMatch(css, /Pontano Sans|Arial Narrow|fonts\.gstatic\.com/);
  assert.match(css, /font-stretch:\s*normal/);
});

test('both themes focus with the accent green; neutral surfaces carry no green', () => {
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-theme="light"\]\s*\{[^}]*--nd-brand-primary-hover:\s*#3b6c1e[^}]*--nd-brand-unselected:\s*#f4f4f5[^}]*--nd-brand-border:\s*#e5e6e5[^}]*--nd-brand-focus:\s*#467d25/s);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--nd-brand-focus\)/s);
});

test('top-bar hosts keep their fallback content until the shared bar exists', () => {
  assert.match(css, /\[data-neurodesk-top-bar-host\]:has\(> \.nd-app-bar\)\s*>\s*:not\(\.nd-app-bar\)\s*\{[^}]*display:\s*none\s*!important/s);
  assert.doesNotMatch(css, /\[data-neurodesk-top-bar-host\]\s*>\s*:not\(\.nd-app-bar\)\s*\{[^}]*display:\s*none\s*!important/s);
});

// SciGet's palette restates every token it changes; the rest keep Neurodesk's
// value for the same light or dark mode.
function scigetToken(name, mode) {
  const selector = mode === 'light'
    ? /:root\[data-neurodesk-app\]\[data-neurodesk-brand="sciget"\]\[data-neurodesk-theme="light"\]\s*\{([^}]*)\}/
    : /:root\[data-neurodesk-app\]\[data-neurodesk-brand="sciget"\]:not\(\[data-neurodesk-theme="light"\]\)\s*\{([^}]*)\}/;
  const block = css.match(selector);
  assert.ok(block, `missing the SciGet ${mode} palette block`);
  const match = block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (match) return match[1].toLowerCase();
  return mode === 'light' ? lightToken(name) : token(name);
}

test('SciGet pages take sciget.org\'s orange accent and greys, at WCAG AA contrast', () => {
  assert.equal(scigetToken('nd-brand-primary', 'dark'), '#d97706');
  assert.equal(scigetToken('nd-brand-page', 'dark'), '#17181c');
  assert.equal(scigetToken('nd-brand-surface', 'dark'), '#23262f');
  assert.equal(scigetToken('nd-brand-primary', 'light'), '#b85c00');
  assert.equal(scigetToken('nd-brand-page', 'light'), '#ffffff');
  assert.match(css, /:root\[data-neurodesk-app\]\[data-neurodesk-brand="sciget"\]\s*\{[^}]*--nd-font-ui:\s*-apple-system/);
  const pairs = [
    ['nd-brand-text', 'nd-brand-surface'],
    ['nd-brand-text-muted', 'nd-brand-surface'],
    ['nd-brand-action-text', 'nd-brand-primary'],
    ['nd-brand-menu-text', 'nd-brand-menu'],
    ['nd-brand-primary', 'nd-brand-menu'],
    ['nd-brand-light', 'nd-brand-surface'],
    ['nd-brand-text-dim', 'nd-brand-pale'],
    ['nd-brand-success', 'nd-brand-surface'],
    ['nd-brand-console-text', 'nd-brand-console-surface'],
    ['nd-brand-console-time', 'nd-brand-console-surface'],
  ];
  for (const mode of ['dark', 'light']) {
    for (const [foreground, background] of pairs) {
      const ratio = contrast(scigetToken(foreground, mode), scigetToken(background, mode));
      assert.ok(ratio >= 4.5, `SciGet ${mode} ${foreground} on ${background}: ${ratio.toFixed(2)} < 4.5`);
    }
  }
});
