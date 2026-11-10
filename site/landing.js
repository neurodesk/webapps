import { initAnalytics } from './analytics.js';

const measurementId = document.querySelector('meta[name="neurodesk-ga4-measurement-id"]')?.content;
if (measurementId) initAnalytics(measurementId);

const searchInput = document.querySelector('#app-search');
const clearSearch = document.querySelector('#clear-search');
const resetFilters = document.querySelector('#reset-filters');
const resultSummary = document.querySelector('#result-summary');
const noResults = document.querySelector('#no-results');
const cards = [...document.querySelectorAll('[data-app-card]')];
const sections = [...document.querySelectorAll('[data-category-section]')];
const totalApps = new Set(cards.map((card) => card.dataset.appId)).size;
const categoryFilters = [...document.querySelectorAll('[data-category-filter]')];
const elsewhere = document.querySelector('#elsewhere');
const elsewhereResults = document.querySelector('#elsewhere-results');
const elsewhereApps = JSON.parse(document.querySelector('#elsewhere-apps')?.textContent ?? '[]');

let activeCategory = 'all';

function normalize(value) {
  return value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function searchTerms(query) {
  return normalize(query).split(/\s+/).filter(Boolean);
}

function matchesTerms(search, terms) {
  const searchable = normalize(search);
  return terms.every((term) => searchable.includes(term));
}

function elsewhereCard(app) {
  const card = document.createElement('a');
  card.className = 'app-card';
  card.href = app.url;
  card.dataset.elsewhereAppId = app.id;
  const topline = document.createElement('span');
  topline.className = 'app-card__topline';
  const catalog = document.createElement('span');
  catalog.className = 'app-card__category';
  catalog.textContent = app.catalogTitle;
  topline.append(catalog);
  const titleRow = document.createElement('span');
  titleRow.className = 'app-card__title-row';
  const title = document.createElement('h3');
  title.textContent = app.title;
  const arrow = document.createElement('span');
  arrow.className = 'app-card__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '↗';
  titleRow.append(title, arrow);
  const description = document.createElement('p');
  description.textContent = app.description;
  const tags = document.createElement('ul');
  tags.className = 'app-card__tags';
  tags.setAttribute('aria-label', 'Host');
  const host = document.createElement('li');
  host.textContent = `Opens on ${app.host}`;
  tags.append(host);
  card.append(topline, titleRow, description, tags);
  return card;
}

function showElsewhere(terms) {
  if (!elsewhere) return;
  const matches = terms.length ? elsewhereApps.filter((app) => matchesTerms(app.search, terms)) : [];
  elsewhereResults.replaceChildren(...matches.map(elsewhereCard));
  elsewhere.hidden = matches.length === 0;
}

function filterCatalog() {
  const query = searchInput.value.trim();
  const terms = searchTerms(query);
  const visibleApps = new Set();
  let localMatch = false;

  for (const card of cards) {
    const matchesCategory = activeCategory === 'all' || card.dataset.category === activeCategory;
    const matchesSearch = matchesTerms(card.dataset.search, terms);
    localMatch ||= matchesSearch;
    card.hidden = !(matchesCategory && matchesSearch);
    if (!card.hidden) visibleApps.add(card.dataset.appId);
  }

  for (const section of sections) {
    section.hidden = !cards.some((card) => !card.hidden && card.dataset.category === section.dataset.categorySection);
  }

  const activeButton = categoryFilters.find((button) => button.dataset.categoryFilter === activeCategory);
  const categoryName = activeCategory === 'all'
    ? ''
    : ` in ${activeButton.childNodes[0].textContent.trim()}`;
  resultSummary.textContent = query || activeCategory !== 'all'
    ? `Showing ${visibleApps.size} of ${totalApps} apps${categoryName}`
    : `${totalApps} apps across ${sections.length} categories`;
  clearSearch.hidden = !query;
  noResults.hidden = visibleApps.size !== 0;
  // Another host's apps only when no app here matches, whatever the category.
  showElsewhere(localMatch ? [] : terms);
}

function selectCategory(category) {
  activeCategory = category;
  for (const button of categoryFilters) {
    const active = button.dataset.categoryFilter === category;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  filterCatalog();
}

function resetCatalog() {
  searchInput.value = '';
  selectCategory('all');
  searchInput.focus();
}

searchInput.addEventListener('input', filterCatalog);
clearSearch.addEventListener('click', () => {
  searchInput.value = '';
  filterCatalog();
  searchInput.focus();
});
resetFilters.addEventListener('click', resetCatalog);

for (const button of categoryFilters) {
  button.addEventListener('click', () => selectCategory(button.dataset.categoryFilter));
}

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === 'Escape' && document.activeElement === searchInput && searchInput.value) {
    searchInput.value = '';
    filterCatalog();
  }
});

const analyticsSummary = document.querySelector('[data-analytics-summary]');
const analyticsApps = document.querySelector('[data-analytics-apps]');
const analyticsPeriod = document.querySelector('[data-analytics-period]');
const analyticsUpdated = document.querySelector('[data-analytics-updated]');
const integer = new Intl.NumberFormat();

function renderAnalyticsUnavailable(message = 'Aggregate analytics are not available yet.') {
  analyticsPeriod.textContent = message;
  analyticsUpdated.textContent = '';
  analyticsApps.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 4;
  cell.textContent = 'Statistics will appear after the next analytics-enabled deployment.';
  row.append(cell);
  analyticsApps.append(row);
}

function countryText(countries) {
  return countries.length
    ? countries.map((country) => `${country.name} (${integer.format(country.users)})`).join(', ')
    : 'Not enough aggregate data';
}

function renderAnalytics(data) {
  if (data.unavailable) {
    renderAnalyticsUnavailable();
    return;
  }

  const summaryValues = [data.totals.users, data.totals.pageViews, data.countries.length];
  [...analyticsSummary.querySelectorAll('strong')].forEach((node, index) => {
    node.textContent = integer.format(summaryValues[index]);
  });
  analyticsPeriod.textContent = `Previous ${data.periodDays} days`;
  analyticsUpdated.textContent = data.generatedAt
    ? `Updated ${new Date(data.generatedAt).toLocaleDateString()}`
    : '';

  analyticsApps.replaceChildren();
  for (const app of data.apps) {
    const row = document.createElement('tr');
    const appCell = document.createElement('th');
    appCell.scope = 'row';
    const link = document.createElement('a');
    link.href = `./${app.path}/`;
    link.textContent = app.title;
    appCell.append(link);
    const users = document.createElement('td');
    users.textContent = integer.format(app.users);
    const views = document.createElement('td');
    views.textContent = integer.format(app.pageViews);
    const countries = document.createElement('td');
    countries.textContent = countryText(app.countries);
    row.append(appCell, users, views, countries);
    analyticsApps.append(row);
  }
}

if (analyticsApps) {
  fetch('./analytics.json')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(renderAnalytics)
    .catch(() => renderAnalyticsUnavailable('Aggregate analytics could not be loaded.'));
}

