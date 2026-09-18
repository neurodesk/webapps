const escape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function renderCard(app, category, categories) {
  const categoryTitles = categories
    .filter(({ id }) => app.categories.includes(id))
    .map(({ title }) => title);
  const searchText = [app.title, app.description, ...categoryTitles, ...app.keywords].join(' ');
  const tags = app.keywords.slice(0, 3)
    .map((keyword) => `<li>${escape(keyword)}</li>`)
    .join('');
  const status = app.support_status === 'experimental'
    ? '<span class="app-card__status">Experimental</span>'
    : '';

  return `
          <a class="app-card" href="./${escape(app.path)}/" data-app-card data-app-id="${escape(app.id)}" data-category="${escape(category.id)}" data-search="${escape(searchText.toLocaleLowerCase())}">
            <span class="app-card__topline">
              <span class="app-card__category">${escape(category.title)}</span>
              ${status}
            </span>
            <span class="app-card__title-row">
              <h3>${escape(app.title)}</h3>
              <span class="app-card__arrow" aria-hidden="true">↗</span>
            </span>
            <p>${escape(app.description)}</p>
            <ul class="app-card__tags" aria-label="Search keywords">${tags}</ul>
          </a>`;
}

function renderCategory(category, apps, index, categories) {
  const cards = apps.map((app) => renderCard(app, category, categories)).join('');
  return `
      <section class="category-section" id="category-${escape(category.id)}" data-category-section="${escape(category.id)}" aria-labelledby="heading-${escape(category.id)}">
        <header class="category-section__header">
          <div>
            <p class="category-section__index">${String(index + 1).padStart(2, '0')}</p>
            <h2 id="heading-${escape(category.id)}">${escape(category.title)}</h2>
          </div>
          <p>${escape(category.description)}</p>
        </header>
        <div class="app-grid">${cards}
        </div>
      </section>`;
}

export function renderLandingPage(registry) {
  const totalApps = registry.apps.length;
  const totalCategories = registry.site.categories.length;
  const categoryButtons = registry.site.categories.map((category) => {
    const count = registry.apps.filter((app) => app.categories.includes(category.id)).length;
    return `<button class="filter-chip" type="button" data-category-filter="${escape(category.id)}" aria-pressed="false">${escape(category.title)} <span>${count}</span></button>`;
  }).join('');
  const categorySections = registry.site.categories.map((category, index) => {
    const apps = registry.apps.filter((app) => app.categories.includes(category.id));
    return renderCategory(category, apps, index, registry.site.categories);
  }).join('');

  return `<!doctype html>
<html lang="en" data-neurodesk-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Privacy-preserving neuroimaging tools that run locally in your browser.">
  <meta name="neurodesk-ga4-measurement-id" content="${escape(registry.site.analytics.measurement_id)}">
  <title>Neurodesk Webapps</title>
  <script src="./theme.js" data-neurodesk-theme-controller></script>
  <link rel="stylesheet" href="./landing.css">
  <script type="module" src="./landing.js"></script>
</head>
<body>
  <header class="site-header">
    <div class="site-header__inner">
      <a class="brand" href="https://neurodesk.org/" aria-label="Neurodesk home"><img src="./neurodesk-logo.svg" alt="Neurodesk"></a>
      <nav class="site-nav" aria-label="Neurodesk navigation">
        <a href="https://github.com/neurodesk/webapps">GitHub</a>
        <a class="theme-toggle standalone-link" href="https://github.com/neurodesk/webapps/releases?q=Neurodesk+Webapps&amp;expanded=true" title="Download the latest full desktop suite for macOS, Windows or Linux">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>
          <span>Standalone</span>
        </a>
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
        <p class="eyebrow">Neurodesk Webapps</p>
        <h1 id="page-title">Run Neuroimaging Tools in Your Browser</h1>
        <p class="hero__lede">Segment, register, measure, prepare, and explore imaging data in your browser without installing software or uploading your scans.</p>
      </div>
      <aside class="privacy-card" aria-label="Privacy information">
        <div class="privacy-card__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3 5.5 5.8v5.1c0 4.2 2.7 8.1 6.5 9.5 3.8-1.4 6.5-5.3 6.5-9.5V5.8L12 3Z"/><path d="m9 12 2 2 4-4"/></svg>
        </div>
        <div><strong>Your data stays with you</strong><span>Processing happens locally on your device.</span></div>
      </aside>
    </section>

    <section class="catalog-controls" aria-label="Find a webapp">
      <div class="search-box">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
        <label class="sr-only" for="app-search">Search webapps</label>
        <input id="app-search" type="search" autocomplete="off" placeholder="Search by app, task, format, or keyword…">
        <kbd aria-hidden="true">/</kbd>
        <button id="clear-search" class="clear-search" type="button" hidden>Clear</button>
      </div>
      <div class="catalog-controls__meta">
        <p id="result-summary" aria-live="polite">${totalApps} apps across ${totalCategories} categories</p>
        <div class="filter-chips" aria-label="Filter by category">
          <button class="filter-chip is-active" type="button" data-category-filter="all" aria-pressed="true">All apps <span>${totalApps}</span></button>
          ${categoryButtons}
        </div>
      </div>
    </section>

    <div id="app-catalog" class="catalog" aria-label="Available webapps">${categorySections}
    </div>

    <section id="no-results" class="no-results" hidden>
      <div aria-hidden="true">⌕</div>
      <h2>No matching apps</h2>
      <p>Try a broader term, another category, or search for a file format such as DICOM or NIfTI.</p>
      <button id="reset-filters" type="button">Show all apps</button>
    </section>

    <section class="analytics-section" id="analytics" aria-labelledby="analytics-title">
      <header class="analytics-section__header">
        <div>
          <p class="eyebrow">Aggregate usage</p>
          <h2 id="analytics-title">Webapp analytics</h2>
        </div>
        <p>See how many people use each webapp and the countries they access it from. These are aggregate page-view statistics only; Do Not Track and Global Privacy Control are respected.</p>
      </header>
      <div class="analytics-summary" data-analytics-summary aria-live="polite">
        <article><strong>—</strong><span>People</span></article>
        <article><strong>—</strong><span>Page views</span></article>
        <article><strong>—</strong><span>Countries</span></article>
      </div>
      <div class="analytics-panel">
        <div class="analytics-panel__heading">
          <div>
            <h3>Usage by app</h3>
            <p data-analytics-period>Loading aggregate statistics…</p>
          </div>
          <p data-analytics-updated></p>
        </div>
        <div class="analytics-table-wrap">
          <table class="analytics-table">
            <thead><tr><th>App</th><th>People</th><th>Page views</th><th>Top countries</th></tr></thead>
            <tbody data-analytics-apps><tr><td colspan="4">Loading analytics…</td></tr></tbody>
          </table>
        </div>
      </div>
      <p class="analytics-privacy">No custom events, filenames, imaging metadata, processing settings, measurements, or results are sent to Google Analytics. Countries with fewer than five visitors are not published.</p>
    </section>
  </main>

  <footer class="site-footer">
    <div class="site-footer__inner">
      <p><strong>Neurodesk Webapps</strong><span>Open, local-first tools for neuroimaging.</span></p>
      <nav aria-label="Footer navigation">
        <a href="https://neurodesk.org/">About Neurodesk</a>
        <a href="./surf/">Go surfing</a>
        <a href="https://lightniing.org/">lightNIIng</a>
        <a href="https://github.com/neurodesk/webapps">View source</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;
}
