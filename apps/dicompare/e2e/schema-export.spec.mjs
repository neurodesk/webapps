import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { loadDicompare, createSession } from '../../../packages/dicompare/src/node.js';

test('downloaded browser schemas preserve Python export semantics and enforce every acquisition', async ({ page }, testInfo) => {
  const contains = { name: 'SeriesDescription', tag: '0008,103E', value: 'T1', vr: 'LO', validationRule: { type: 'contains', contains: '' } };
  const acquisitions = ['Scan', '__proto__', 'constructor', 'prototype'].map((protocolName, index) => ({
    id: `export-${index}`,
    protocolName,
    seriesDescription: '',
    totalFiles: 0,
    metadata: {},
    acquisitionFields: [{ ...(index === 0 ? contains : { name: 'Modality', tag: '0008,0060', value: 'MR', vr: 'CS' }), level: 'acquisition' }],
    series: index === 0 ? [{ name: 'Series 1', fields: [contains] }] : [],
  }));
  const metadata = { name: 'Export regression', description: '', version: '1.0', authors: [] };
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'From data', exact: true })).toBeVisible();
  await page.evaluate(async ({ acquisitions, metadata }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('DicompareSessionsDB', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('sessions', 'readwrite');
        transaction.objectStore('sessions').put({
          id: 'export-regression',
          metadata: { id: 'export-regression', name: metadata.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), itemCount: acquisitions.length, storageSize: 0 },
          items: acquisitions.map(acquisition => ({ id: acquisition.id, acquisition, source: 'empty', isEditing: false, hasCreatedSchema: true })),
          schemaMetadata: metadata,
          selectedId: null,
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, { acquisitions, metadata });
  await page.reload();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: '__proto__', exact: true })).toBeVisible();
  await page.getByTitle('Save schema', { exact: true }).click();
  await page.getByRole('button', { name: 'Preview JSON', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await downloading;
  const json = await readFile(await download.path(), 'utf8');
  await writeFile(testInfo.outputPath('browser-export.json'), json);
  const exported = JSON.parse(json);
  expect(Object.keys(exported.acquisitions)).toEqual(acquisitions.map(acquisition => acquisition.protocolName));

  const runtime = await loadDicompare();
  const session = createSession(runtime);
  const pythonExport = await session.generateSchema(acquisitions, metadata);
  expect(exported).toEqual(pythonExport);
  const results = [];
  for (const [index, acquisition] of acquisitions.entries()) {
    const actual = index === 0 ? {
      ...acquisition,
      acquisitionFields: [{ ...contains, value: 'T2 FLAIR' }],
      series: [{ name: 'Series 1', fields: [{ ...contains, value: 'T2 FLAIR' }] }],
    } : acquisition;
    const valid = await session.validateAcquisition(actual, json, index);
    expect(valid.length).toBeGreaterThan(0);
    expect(valid, JSON.stringify(valid)).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'pass' })]));
    expect(valid.every(result => result.status === 'pass')).toBe(true);
    let invalid = [];
    if (index !== 0) {
      invalid = await session.validateAcquisition({ ...actual, acquisitionFields: [{ ...actual.acquisitionFields[0], value: 'CT' }] }, json, index);
      expect(invalid).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'Modality', status: 'fail' })]));
    }
    results.push({ name: acquisition.protocolName, valid, invalid });
  }
  await writeFile(testInfo.outputPath('python-validation.json'), JSON.stringify({ versions: runtime.versions, results }, null, 2));
});
