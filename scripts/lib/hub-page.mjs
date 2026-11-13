import { brandAttribute, catalogApps } from './apps-registry.mjs';

const escape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function renderCatalogCard(registry, catalog) {
  const count = catalogApps(registry, catalog).length;
  return `
          <a class="app-card" href="https://${escape(catalog.host)}/" data-catalog-card data-catalog-id="${escape(catalog.id)}">
            <span class="app-card__topline">
              <span class="app-card__category">${count} ${count === 1 ? 'app' : 'apps'}</span>
            </span>
            <span class="app-card__title-row">
              <h3>${escape(catalog.title)}</h3>
              <span class="app-card__arrow" aria-hidden="true">↗</span>
            </span>
            <p>${escape(catalog.description)}</p>
            <ul class="app-card__tags" aria-label="Address"><li>${escape(catalog.host)}</li></ul>
          </a>`;
}

/** webapps.sciget.org: one card per catalogue. The hub hosts no apps. */
export function renderHubPage(registry) {
  const { hub } = registry.site;
  const cards = registry.site.catalogs.map((catalog) => renderCatalogCard(registry, catalog)).join('');
  return `<!doctype html>
<html lang="en" data-neurodesk-theme="dark"${brandAttribute(hub.brand)}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="${escape(hub.description)}">
  <title>${escape(hub.title)}</title>
  <link rel="icon" type="image/svg+xml" href="./${escape(hub.brand.icon)}">
  <script src="./theme.js" data-neurodesk-theme-controller></script>
  <link rel="stylesheet" href="./landing.css">
</head>
<body>
  <header class="site-header">
    <div class="site-header__inner">
      <a class="brand" href="${escape(hub.brand.home)}" aria-label="${escape(hub.brand.name)} home"><img src="./${escape(hub.brand.logo)}" alt="${escape(hub.brand.name)}"></a>
      <nav class="site-nav" aria-label="${escape(hub.brand.name)} navigation">
        <a href="https://github.com/neurodesk/webapps">GitHub</a>
        <button class="theme-toggle" type="button" data-neurodesk-theme-toggle aria-label="Use light theme" title="Use light theme">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <span data-neurodesk-theme-label>Light</span>
        </button>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero" aria-labelledby="page-title">
      <div class="hero__copy">
        <p class="eyebrow">${escape(hub.title)}</p>
        <h1 id="page-title">${escape(hub.heading)}</h1>
        <p class="hero__lede">${escape(hub.description)}</p>
      </div>
    </section>

    <div class="catalog" aria-label="Catalogues">
      <section class="category-section" aria-labelledby="heading-catalogues">
        <header class="category-section__header">
          <div>
            <h2 id="heading-catalogues">Catalogues</h2>
          </div>
        </header>
        <div class="app-grid">${cards}
        </div>
      </section>
    </div>
  </main>

  <footer class="site-footer">
    <div class="site-footer__inner">
      <p><strong>${escape(hub.title)}</strong><span>Open, local-first imaging tools that run in your browser.</span></p>
      <nav aria-label="Footer navigation">
        <a href="https://lightniing.org/">lightNIIng</a>
        <a href="https://github.com/neurodesk/webapps">View source</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;
}
