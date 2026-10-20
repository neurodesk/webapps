import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import {
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
