import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import {
  appHosts,
  dimensionFilter,
  emptyAnalytics,
  MIN_PUBLISHED_COUNTRY_USERS,
  rankApps,
  summarizeCountries,
  summarizeMetrics,
} from '../scripts/write-analytics.mjs';

test('builds a host and app-path GA4 filter without custom dimensions', () => {
  assert.deepEqual(dimensionFilter({
    hostName: 'webapps.neurodesk.org',
    pagePathPrefix: '/sct/',
  }), {
    andGroup: {
      expressions: [
        { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: 'webapps.neurodesk.org', caseSensitive: false } } },
        { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/sct/', caseSensitive: false } } },
      ],
    },
  });
});

test('builds an aggregate filter limited to registered app paths', () => {
  const filter = dimensionFilter({
    hostName: 'webapps.neurodesk.org',
    pagePathPrefixes: ['/vesselboost/', '/calmar/'],
  });
  assert.equal(filter.andGroup.expressions[0].filter.fieldName, 'hostName');
  assert.deepEqual(
    filter.andGroup.expressions[1].orGroup.expressions.map(
      (expression) => expression.filter.stringFilter.value,
    ),
    ['/vesselboost/', '/calmar/'],
  );
});

test('counts each app on its catalogue host, and a moved app on the primary domain too', async () => {
  const registry = await loadAppsRegistry();
  const app = (id) => registry.apps.find((entry) => entry.id === id);
  assert.deepEqual(appHosts(registry, app('dicomview')), ['webapps.neurodesk.org', 'mskapps.sciget.org', 'preclinicalapps.sciget.org']);
  assert.deepEqual(appHosts(registry, app('synthseg')), ['webapps.neurodesk.org']);
  assert.deepEqual(appHosts(registry, app('musclemap')), ['mskapps.sciget.org', 'webapps.neurodesk.org']);
  assert.deepEqual(appHosts(registry, app('structure-tensor')), ['microscopyapps.sciget.org', 'preclinicalapps.sciget.org', 'webapps.neurodesk.org']);
  assert.deepEqual(dimensionFilter({ hostName: ['mskapps.sciget.org', 'webapps.neurodesk.org'] }), {
    filter: { fieldName: 'hostName', inListFilter: { values: ['mskapps.sciget.org', 'webapps.neurodesk.org'], caseSensitive: false } },
  });
});

test('summarizes GA4 users and page views', () => {
  assert.deepEqual(summarizeMetrics([{ metricValues: [{ value: '42' }, { value: '117' }] }]), {
    users: 42,
    pageViews: 117,
  });
});

test('publishes only aggregate countries with at least five users', () => {
  const rows = [
    { dimensionValues: [{ value: 'AU' }, { value: 'Australia' }], metricValues: [{ value: '12' }] },
    { dimensionValues: [{ value: 'NZ' }, { value: 'New Zealand' }], metricValues: [{ value: String(MIN_PUBLISHED_COUNTRY_USERS) }] },
    { dimensionValues: [{ value: 'DE' }, { value: 'Germany' }], metricValues: [{ value: '4' }] },
  ];
  assert.deepEqual(summarizeCountries(rows), [
    { code: 'AU', name: 'Australia', users: 12 },
    { code: 'NZ', name: 'New Zealand', users: 5 },
  ]);
});

test('placeholder analytics covers every registered app', async () => {
  const registry = await loadAppsRegistry();
  const placeholder = emptyAnalytics(registry);
  assert.equal(placeholder.unavailable, true);
  assert.deepEqual(placeholder.apps.map(({ id }) => id), registry.apps.map(({ id }) => id));
  assert.deepEqual(Object.keys(placeholder.catalogs), registry.site.catalogs.map(({ id }) => id));
});

test('ranks apps by visitors, then page views, then title', () => {
  const apps = [
    { title: 'Deface', users: 3, pageViews: 9 },
    { title: 'CALMaR', users: 40, pageViews: 50 },
    { title: 'SeedSeg', users: 3, pageViews: 12 },
    { title: 'Brain2Print', users: 3, pageViews: 9 },
  ];
  assert.deepEqual(rankApps(apps).map(({ title }) => title), ['CALMaR', 'SeedSeg', 'Brain2Print', 'Deface']);
  assert.equal(apps[0].title, 'Deface');
});

test('a catalogue report lists its apps with its own totals and countries', async () => {
  const { catalogAnalytics } = await import('../scripts/lib/catalog-sites.mjs');
  const { catalogApps, findCatalog } = await import('../scripts/lib/apps-registry.mjs');
  const registry = await loadAppsRegistry();
  const msk = findCatalog(registry, 'msk');
  const report = emptyAnalytics(registry, '2026-11-09T00:00:00.000Z');
  report.totals = { users: 100, pageViews: 300 };
  report.catalogs.msk = { totals: { users: 7, pageViews: 20 }, countries: [{ code: 'AU', name: 'Australia', users: 6 }] };
  const own = catalogAnalytics(report, catalogApps(registry, msk), msk);
  assert.deepEqual(own.totals, { users: 7, pageViews: 20 });
  assert.deepEqual(own.countries, [{ code: 'AU', name: 'Australia', users: 6 }]);
  assert.deepEqual(own.apps.map(({ id }) => id).sort(), catalogApps(registry, msk).map(({ id }) => id).sort());
  assert.equal('catalogs' in own, false);
  assert.throws(() => catalogAnalytics({ ...report, catalogs: undefined }, [], msk), /no report for catalogue msk/);
});

test('catalogue analytics includes new apps absent from the saved report', async () => {
  const { catalogAnalytics } = await import('../scripts/lib/catalog-sites.mjs');
  const existing = { id: 'old', path: 'old', title: 'Old', users: 7, pageViews: 9, countries: [] };
  const report = { apps: [existing], catalogs: { microscopy: { totals: { users: 7, pageViews: 9 }, countries: [] } } };
  const own = catalogAnalytics(report, [existing, { id: 'new', path: 'new', title: 'New' }], { id: 'microscopy' });
  assert.deepEqual(own.apps, [existing, { id: 'new', path: 'new', title: 'New', users: 0, pageViews: 0, countries: [] }]);
  assert.deepEqual(own.totals, report.catalogs.microscopy.totals);
});

test('catalogue analytics ranks completed rows by usage rather than registry order', async () => {
  const { catalogAnalytics } = await import('../scripts/lib/catalog-sites.mjs');
  const rows = [
    { id: 'a', title: 'A', users: 1, pageViews: 2 },
    { id: 'b', title: 'B', users: 100, pageViews: 100 },
    { id: 'c', title: 'C', users: 1, pageViews: 3 },
    { id: 'd', title: 'D', users: 1, pageViews: 2 },
  ];
  const report = { apps: [rows[1], rows[2], rows[0], rows[3]], catalogs: { microscopy: {} } };
  const apps = [{ id: 'new', path: 'new', title: 'New' }, ...rows];
  const own = catalogAnalytics(report, apps, { id: 'microscopy' });
  assert.deepEqual(own.apps.map(({ id }) => id), ['b', 'c', 'a', 'd', 'new']);
  assert.deepEqual(apps.map(({ id }) => id), ['new', 'a', 'b', 'c', 'd']);
});
