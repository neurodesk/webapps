#!/usr/bin/env node
import { createSign } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';

const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DEFAULT_OUTPUT = resolve(repoRoot, 'site', 'analytics.json');
export const MIN_PUBLISHED_COUNTRY_USERS = 5;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function dimensionFilter({ hostName, pagePathPrefix, pagePathPrefixes = [] }) {
  const expressions = [{
    filter: {
      fieldName: 'hostName',
      stringFilter: { matchType: 'EXACT', value: hostName, caseSensitive: false },
    },
  }];
  if (pagePathPrefix) {
    expressions.push({
      filter: {
        fieldName: 'pagePath',
        stringFilter: { matchType: 'BEGINS_WITH', value: pagePathPrefix, caseSensitive: false },
      },
    });
  }
  if (pagePathPrefixes.length) {
    expressions.push({
      orGroup: {
        expressions: pagePathPrefixes.map((value) => ({
          filter: {
            fieldName: 'pagePath',
            stringFilter: { matchType: 'BEGINS_WITH', value, caseSensitive: false },
          },
        })),
      },
    });
  }
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

export function summarizeMetrics(rows) {
  const values = rows?.[0]?.metricValues ?? [];
  return {
    users: Number.parseInt(values[0]?.value ?? '0', 10) || 0,
    pageViews: Number.parseInt(values[1]?.value ?? '0', 10) || 0,
  };
}

export function summarizeCountries(rows, limit = 5) {
  return (rows ?? []).map((row) => {
    const dimensions = row.dimensionValues ?? [];
    return {
      code: String(dimensions[0]?.value ?? '').toUpperCase(),
      name: String(dimensions[1]?.value ?? ''),
      users: Number.parseInt(row.metricValues?.[0]?.value ?? '0', 10) || 0,
    };
  }).filter((country) => /^[A-Z]{2}$/.test(country.code)
      && country.name
      && country.users >= MIN_PUBLISHED_COUNTRY_USERS)
    .sort((left, right) => right.users - left.users || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function rankApps(apps) {
  return [...apps].sort((left, right) => right.users - left.users
    || right.pageViews - left.pageViews
    || left.title.localeCompare(right.title));
}

export function emptyAnalytics(registry, generatedAt = null) {
  return {
    schemaVersion: 1,
    generatedAt,
    source: 'Google Analytics 4',
    periodDays: registry.site.analytics.period_days,
    unavailable: true,
    totals: { users: 0, pageViews: 0 },
    countries: [],
    apps: registry.apps.map((app) => ({
      id: app.id,
      path: app.path,
      title: app.title,
      users: 0,
      pageViews: 0,
      countries: [],
    })),
  };
}

async function accessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: ANALYTICS_SCOPE,
    aud: serviceAccount.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(unsigned).end()
    .sign(serviceAccount.private_key, 'base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch(serviceAccount.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()).access_token;
}

async function runReport({ token, propertyId, periodDays, filter, dimensions = [], metrics, limit = 1000 }) {
  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${periodDays}daysAgo`, endDate: 'today' }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        dimensionFilter: filter,
        orderBys: dimensions.includes('country')
          ? [{ metric: { metricName: 'totalUsers' }, desc: true }]
          : undefined,
        limit: String(limit),
      }),
    },
  );
  if (!response.ok) throw new Error(`GA4 Data API returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return (await response.json()).rows ?? [];
}

async function metricsForFilter(context, filter) {
  const [metricsRows, countryRows] = await Promise.all([
    runReport({
      ...context,
      filter,
      metrics: ['totalUsers', 'screenPageViews'],
    }),
    runReport({
      ...context,
      filter,
      dimensions: ['countryId', 'country'],
      metrics: ['totalUsers'],
      limit: 100,
    }),
  ]);
  return {
    ...summarizeMetrics(metricsRows),
    countries: summarizeCountries(countryRows),
  };
}

export async function collectAnalytics({ registry, propertyId, serviceAccount }) {
  const token = await accessToken(serviceAccount);
  const context = {
    token,
    propertyId,
    periodDays: registry.site.analytics.period_days,
  };
  const hostName = registry.site.domain;
  const totals = await metricsForFilter(context, dimensionFilter({
    hostName,
    pagePathPrefixes: registry.apps.map((app) => `/${app.path}/`),
  }));
  const apps = [];
  for (const app of registry.apps) {
    const appMetrics = await metricsForFilter(context, dimensionFilter({
      hostName,
      pagePathPrefix: `/${app.path}/`,
    }));
    apps.push({
      id: app.id,
      path: app.path,
      title: app.title,
      ...appMetrics,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'Google Analytics 4',
    periodDays: registry.site.analytics.period_days,
    unavailable: false,
    totals: { users: totals.users, pageViews: totals.pageViews },
    countries: totals.countries,
    apps: rankApps(apps),
  };
}

export async function writeAnalytics(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  const registry = await loadAppsRegistry();
  const output = resolve(option('--output') || DEFAULT_OUTPUT);
  const propertyId = (option('--property-id') || process.env.GA4_PROPERTY_ID || '').trim();
  const serviceAccountJson = (process.env.GA4_SERVICE_ACCOUNT_KEY || '').trim();
  const allowMissing = process.argv.includes('--allow-missing-credentials');

  if (!propertyId || !serviceAccountJson) {
    if (!allowMissing) throw new Error('GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_KEY are required');
    await writeAnalytics(output, emptyAnalytics(registry));
    console.log(`Analytics credentials unavailable; wrote placeholder to ${output}`);
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (error) {
    throw new Error(`GA4_SERVICE_ACCOUNT_KEY is not valid JSON: ${error.message}`);
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('GA4_SERVICE_ACCOUNT_KEY must contain client_email and private_key');
  }

  const data = await collectAnalytics({ registry, propertyId, serviceAccount });
  await writeAnalytics(output, data);
  console.log(`Wrote ${data.apps.length} app analytics summaries to ${output}`);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await main();
}
