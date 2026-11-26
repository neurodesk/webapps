// A Chrome origin trial token is base64, as the registry validates each catalogue's token.
const ORIGIN_TRIAL_TOKEN = /^[A-Za-z0-9+/]*={0,2}$/;
const appIdPattern = /^[a-z][a-z0-9-]*$/;
const titlePattern = /<title\b[^>]*>[\s\S]*?<\/title>/i;
const iconLinkPattern = /\s*<link\b[^>]*\brel=["']?[^"'>]*\bicon\b[^>]*>/gi;
const placeholderIconPattern = /\bhref=["']data:,?["']/i;
const managedMetaPatterns = [
  /\s*<meta\b[^>]*\bname=["']description["'][^>]*>/gi,
  /\s*<meta\b[^>]*\bproperty=["']og:[^"']*["'][^>]*>/gi,
  /\s*<meta\b[^>]*\bname=["']twitter:[^"']*["'][^>]*>/gi,
  /\s*<link\b[^>]*\brel=["']canonical["'][^>]*>/gi,
];

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Standalone builds and the dev server keep the Neurodesk brand; the composite
// assembly passes the brand of the catalogue that hosts the app.
export const DEFAULT_BRAND = Object.freeze({
  siteTitle: 'Neurodesk Webapps',
  brandName: 'Neurodesk',
  brandTheme: 'neurodesk',
  moreAppsLabel: 'More Neurodesk web apps',
});

export function hostedAppTitle(title, siteTitle = DEFAULT_BRAND.siteTitle) {
  return `${title} | ${siteTitle}`;
}

// mountImagingWorkspace gives these regions their classes, but only once the app bundle has run.
// Carrying them in the document lets the first paint use the final layout.
const workspaceRegions = [['controls', 'nd-imaging-controls'], ['viewer', 'nd-imaging-viewer'], ['status', 'nd-imaging-status']];

function stampWorkspaceRegions(html) {
  const tags = workspaceRegions.map(([id]) => new RegExp(`<[a-z][a-z0-9-]*\\b[^>]*\\sid=["']${id}["'][^>]*>`, 'i'));
  if (!tags.every((tag) => tag.test(html))) return html;
  return workspaceRegions.reduce((stamped, [, className], index) => stamped.replace(tags[index], (tag) => {
    const existing = tag.match(/\sclass=(["'])(.*?)\1/i);
    if (!existing) return tag.replace(/\/?>$/, (end) => ` class="${className}"${end}`);
    if (existing[2].split(/\s+/).includes(className)) return tag;
    return tag.replace(existing[0], ` class=${existing[1]}${`${existing[2]} ${className}`.trim()}${existing[1]}`);
  }), html);
}

export function hasIconLink(html) {
  return [...html.matchAll(iconLinkPattern)].some((match) => !placeholderIconPattern.test(match[0]));
}

export function injectCompositeTheme(html, {
  appId,
  shell = 'static-html',
  title,
  description,
  version,
  measurementId,
  url,
  canonical,
  href = '../app-theme.css',
  themeHref = '../theme.js',
  shellHref = '../app-shell.js',
  analyticsHref = '../analytics.js',
  moreAppsHref = '../',
  iconHref = '../neurodesk-logo.svg',
  siteTitle = DEFAULT_BRAND.siteTitle,
  brandName = DEFAULT_BRAND.brandName,
  brandTheme = DEFAULT_BRAND.brandTheme,
  moreAppsLabel = DEFAULT_BRAND.moreAppsLabel,
  catalogId,
  information,
  standaloneHref,
  componentsHref,
  originTrial = '',
}) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (!appIdPattern.test(appId)) throw new Error(`Invalid app id: ${appId}`);
  if (typeof href !== 'string' || !href.trim()) throw new Error('Theme href must be a non-empty string');
  for (const [label, value] of Object.entries({
    title, description, version, shell, measurementId, themeHref, shellHref, analyticsHref, moreAppsHref, iconHref,
    siteTitle, brandName, brandTheme, moreAppsLabel,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label} must be a non-empty string`);
    }
  }
  if (catalogId !== undefined && !appIdPattern.test(catalogId)) throw new Error(`Invalid catalog id: ${catalogId}`);
  if (!ORIGIN_TRIAL_TOKEN.test(originTrial)) throw new Error('originTrial must be an origin trial token or empty');
  for (const [label, value] of Object.entries({ url, canonical })) {
    if (value !== undefined && !/^https?:\/\/\S+$/.test(value)) {
      throw new Error(`${label} must be an absolute http(s) URL, got ${value}`);
    }
  }
  if (!/<html\b/i.test(html)) throw new Error(`Cannot theme ${appId}: missing <html> element`);
  if (!/<\/head>/i.test(html)) throw new Error(`Cannot theme ${appId}: missing </head> element`);

  let themed = html;

  // Normalize the document metadata from the registry so every hosted app
  // shares one <title> convention and is searchable/linkable with the same
  // copy the catalog shows. The managed tags are rewritten as one block right
  // after <title> so repeated runs produce identical output.
  const meta = (attribute, name, content) => (
    `<meta ${attribute}="${name}" content="${escapeAttribute(content)}">`
  );
  const normalizedTitle = hostedAppTitle(title, siteTitle);
  const metadataBlock = [
    `<title>${escapeAttribute(normalizedTitle)}</title>`,
    meta('name', 'description', description),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', normalizedTitle),
    meta('property', 'og:description', description),
    ...(url ? [meta('property', 'og:url', url)] : []),
    meta('name', 'twitter:card', 'summary'),
    ...(canonical ? [`<link rel="canonical" href="${escapeAttribute(canonical)}">`] : []),
  ].join('\n  ');
  for (const pattern of managedMetaPatterns) themed = themed.replace(pattern, '');
  if (titlePattern.test(themed)) {
    themed = themed.replace(titlePattern, metadataBlock);
  } else {
    themed = themed.replace(/<\/head>/i, `  ${metadataBlock}\n</head>`);
  }

  // Apps without a favicon fall back to the shared site mark. A `data:,`
  // placeholder only suppresses the browser's favicon request, so it is
  // treated as absent and dropped. A mark placed by an earlier run is replaced,
  // so the catalogue that hosts the app decides it.
  themed = themed.replace(/<link\b[^>]*\bdata-neurodesk-app-icon\b[^>]*>/gi, (tag) => (
    tag.replace(/\bhref="[^"]*"/i, `href="${escapeAttribute(iconHref)}"`)
  ));
  if (!hasIconLink(themed)) {
    themed = themed.replace(iconLinkPattern, '');
    themed = themed.replace(
      /<\/head>/i,
      `  <link rel="icon" type="image/svg+xml" href="${escapeAttribute(iconHref)}" data-neurodesk-app-icon>\n</head>`,
    );
  }

  if (!/<html\b[^>]*\bdata-neurodesk-app=/i.test(themed)) {
    themed = themed.replace(
      /<html\b/i,
      `<html data-neurodesk-app="${escapeAttribute(appId)}" data-neurodesk-shell="${escapeAttribute(shell)}" data-neurodesk-theme="dark"`,
    );
  } else if (!/<html\b[^>]*\bdata-neurodesk-theme=/i.test(themed)) {
    themed = themed.replace(/<html\b/i, '<html data-neurodesk-theme="dark"');
  }

  if (shell === 'imaging-workspace') themed = stampWorkspaceRegions(themed);

  // Name the catalogue that hosts the page, so an app can pick defaults that suit its audience.
  // Standalone builds and the dev server are hosted by no catalogue and carry no attribute.
  if (catalogId !== undefined) {
    const attribute = ` data-neurodesk-catalog="${escapeAttribute(catalogId)}"`;
    themed = themed.replace(/<html\b[^>]*>/i, (tag) => (
      /\sdata-neurodesk-catalog="[^"]*"/i.test(tag)
        ? tag.replace(/\sdata-neurodesk-catalog="[^"]*"/i, attribute)
        : tag.replace(/^<html\b/i, `<html${attribute}`)
    ));
  }

  // A Chrome origin trial token is valid for one origin, so only the catalogue that hosts the page
  // sets it. Every run removes the previous one, and the all-app assembly carries none.
  themed = themed.replace(/\s*<meta http-equiv="origin-trial"[^>]*data-neurodesk-origin-trial[^>]*>/gi, '');
  if (originTrial) {
    themed = themed.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n  <meta http-equiv="origin-trial" content="${escapeAttribute(originTrial)}" data-neurodesk-origin-trial>`);
  }

  // A brand other than Neurodesk restyles the page through the shared app theme. Every
  // run sets or clears it, so the catalogue that hosts the page decides it.
  themed = themed.replace(/<html\b[^>]*>/i, (tag) => {
    const bare = tag.replace(/\sdata-neurodesk-brand="[^"]*"/i, '');
    return brandTheme === DEFAULT_BRAND.brandTheme
      ? bare
      : bare.replace(/>$/, ` data-neurodesk-brand="${escapeAttribute(brandTheme)}">`);
  });

  if (!/data-neurodesk-app-theme(?:\s|=|>)/i.test(themed)) {
    themed = themed.replace(
      /<\/head>/i,
      `  <link rel="stylesheet" href="${escapeAttribute(href)}" data-neurodesk-app-theme>\n</head>`,
    );
  }

  if (!/data-neurodesk-app-shell(?:\s|=|>)/i.test(themed)) {
    const sourceHref = `https://github.com/neurodesk/webapps/tree/main/apps/${appId}`;
    const standaloneAttributes = `${standaloneHref ? ` data-standalone-href="${escapeAttribute(standaloneHref)}"` : ''}${componentsHref ? ` data-components-href="${escapeAttribute(componentsHref)}"` : ''}`;
    themed = themed.replace(
      /<\/head>/i,
      `  <script type="module" src="${escapeAttribute(shellHref)}" data-neurodesk-app-shell data-app-id="${escapeAttribute(appId)}" data-app-shell="${escapeAttribute(shell)}" data-app-title="${escapeAttribute(title)}" data-app-description="${escapeAttribute(description)}" data-app-version="${escapeAttribute(version)}" data-ga4-measurement-id="${escapeAttribute(measurementId)}" data-analytics-href="${escapeAttribute(analyticsHref)}" data-more-apps-href="${escapeAttribute(moreAppsHref)}" data-source-href="${escapeAttribute(sourceHref)}"${standaloneAttributes}${url ? ` data-app-url="${escapeAttribute(url)}"` : ''}></script>\n</head>`,
    );
  }

  // Composite builds may receive an already themed standalone app, restored from a cache keyed
  // without the registry, and theme each app again for the catalogue that hosts it. Update every
  // registry and catalogue value and resource location on each run.
  for (const [name, value] of [
    ['app-title', title],
    ['app-description', description],
    ['app-version', version],
    ['ga4-measurement-id', measurementId],
    ['more-apps-href', moreAppsHref],
    ['brand-name', brandName],
    ['more-apps-label', moreAppsLabel],
    ['app-url', url],
    ['standalone-href', standaloneHref],
    ['components-href', componentsHref],
  ]) {
    if (value === undefined) continue;
    themed = themed.replace(/<script\b[^>]*\bdata-neurodesk-app-shell(?:\s|=|>)[^>]*>/i, tag => {
      const attribute = ` data-${name}="${escapeAttribute(value)}"`;
      const existing = new RegExp(`\\sdata-${name}="[^"]*"`, 'i');
      return existing.test(tag) ? tag.replace(existing, attribute) : tag.replace(/>$/, `${attribute}>`);
    });
  }

  // App information (packages under the hood, method citations and the shared
  // builder, ecosystem and platform statements) travels as one JSON script so
  // the shell renders identical About and Cite dialogs for every app.
  if (information !== undefined) {
    if (!information || typeof information !== 'object') throw new Error('information must be an object');
    const json = JSON.stringify(information).replaceAll('<', '\\u003c');
    const block = `<script type="application/json" data-neurodesk-app-information>${json}</script>`;
    themed = /<script type="application\/json" data-neurodesk-app-information>[\s\S]*?<\/script>/i.test(themed)
      ? themed.replace(/<script type="application\/json" data-neurodesk-app-information>[\s\S]*?<\/script>/i, block)
      : themed.replace(/<\/head>/i, `  ${block}\n</head>`);
  }

  return placeThemeControllerFirst(themed, themeHref);
}

const themeControllerPattern = /[ \t]*<script\b[^>]*\bdata-neurodesk-theme-controller(?=[\s=>])[^>]*>\s*<\/script>\n?/i;

/**
 * The theme controller (site/theme.js) installs the WebMCP tools' event recorder, which must listen
 * before any other script can, so it is the first script of the page: it goes, or moves, right
 * before the first <script> element, after the metadata (an origin trial token among it) it needs.
 */
export function placeThemeControllerFirst(html, themeHref = '../theme.js') {
  const existing = html.match(themeControllerPattern);
  const tag = existing ? existing[0].trim() : `<script src="${escapeAttribute(themeHref)}" data-neurodesk-theme-controller></script>`;
  const rest = existing ? html.replace(themeControllerPattern, '') : html;
  const first = rest.search(/<script\b/i);
  if (first < 0) return rest.replace(/<\/head>/i, `  ${tag}\n</head>`);
  const lineStart = rest.lastIndexOf('\n', first - 1) + 1;
  const indent = /^[ \t]*$/.test(rest.slice(lineStart, first)) ? rest.slice(lineStart, first) : '';
  return `${rest.slice(0, first)}${tag}\n${indent}${rest.slice(first)}`;
}

/** The first executable script of a page, as a parser meets it: its opening tag, or null. */
export function firstPageScript(html) {
  const scripts = html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>/gi);
  for (const [tag] of scripts) {
    const type = tag.match(/\btype=["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (!type || type === 'module' || type === 'text/javascript' || type === 'application/javascript') return tag;
  }
  return null;
}
