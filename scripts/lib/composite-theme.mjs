const appIdPattern = /^[a-z][a-z0-9-]*$/;
const titlePattern = /<title\b[^>]*>[\s\S]*?<\/title>/i;
const iconLinkPattern = /\s*<link\b[^>]*\brel=["']?[^"'>]*\bicon\b[^>]*>/gi;
const placeholderIconPattern = /\bhref=["']data:,?["']/i;
const managedMetaPatterns = [
  /\s*<meta\b[^>]*\bname=["']description["'][^>]*>/gi,
  /\s*<meta\b[^>]*\bproperty=["']og:[^"']*["'][^>]*>/gi,
  /\s*<meta\b[^>]*\bname=["']twitter:[^"']*["'][^>]*>/gi,
];

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function hostedAppTitle(title) {
  return `${title} | Neurodesk Webapps`;
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
  href = '../app-theme.css',
  themeHref = '../theme.js',
  shellHref = '../app-shell.js',
  analyticsHref = '../analytics.js',
  moreAppsHref = '../',
  iconHref = '../neurodesk-logo.svg',
  information,
  standaloneHref,
  componentsHref,
}) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (!appIdPattern.test(appId)) throw new Error(`Invalid app id: ${appId}`);
  if (typeof href !== 'string' || !href.trim()) throw new Error('Theme href must be a non-empty string');
  for (const [label, value] of Object.entries({
    title, description, version, shell, measurementId, themeHref, shellHref, analyticsHref, moreAppsHref, iconHref,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label} must be a non-empty string`);
    }
  }
  if (url !== undefined && !/^https?:\/\/\S+$/.test(url)) {
    throw new Error(`url must be an absolute http(s) URL, got ${url}`);
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
  const normalizedTitle = hostedAppTitle(title);
  const metadataBlock = [
    `<title>${escapeAttribute(normalizedTitle)}</title>`,
    meta('name', 'description', description),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', normalizedTitle),
    meta('property', 'og:description', description),
    ...(url ? [meta('property', 'og:url', url)] : []),
    meta('name', 'twitter:card', 'summary'),
  ].join('\n  ');
  for (const pattern of managedMetaPatterns) themed = themed.replace(pattern, '');
  if (titlePattern.test(themed)) {
    themed = themed.replace(titlePattern, metadataBlock);
  } else {
    themed = themed.replace(/<\/head>/i, `  ${metadataBlock}\n</head>`);
  }

  // Apps without a favicon fall back to the shared site mark. A `data:,`
  // placeholder only suppresses the browser's favicon request, so it is
  // treated as absent and dropped.
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

  if (!/data-neurodesk-theme-controller(?:\s|=|>)/i.test(themed)) {
    themed = themed.replace(
      /<\/head>/i,
      `  <script src="${escapeAttribute(themeHref)}" data-neurodesk-theme-controller></script>\n</head>`,
    );
  }

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

  // Composite builds may receive an already themed standalone app. Update its
  // resource locations before removing the app-local copies during assembly.
  for (const [name, value] of [['standalone-href', standaloneHref], ['components-href', componentsHref]]) {
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

  return themed;
}
