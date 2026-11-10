import assert from 'node:assert/strict'
import test from 'node:test'
import { hostingCatalog, initialSource } from '../src/catalog.ts'

const page = (attributes) => ({
  documentElement: { getAttribute: (name) => attributes[name] ?? null },
})

test('reads the catalogue that hosts the page, if any', () => {
  assert.equal(hostingCatalog(page({ 'data-neurodesk-catalog': 'microscopy' })), 'microscopy')
  assert.equal(hostingCatalog(page({})), null)
})

test('opens on an OME-Zarr URL on the microscopy catalogue', () => {
  assert.equal(initialSource(null, 'microscopy'), 'custom')
})

test('opens on DANDI everywhere else', () => {
  for (const catalogId of [null, 'neuro', 'preclinical', 'msk', 'unknown', 'toString']) {
    assert.equal(initialSource(null, catalogId), 'dandi', String(catalogId))
  }
})

test('a source named in the link wins over the catalogue default', () => {
  assert.equal(initialSource('dandi', 'microscopy'), 'dandi')
  assert.equal(initialSource('custom', null), 'custom')
  assert.equal(initialSource('custom', 'neuro'), 'custom')
})

test('an unknown requested source falls back to the catalogue default', () => {
  assert.equal(initialSource('synthetic', 'microscopy'), 'custom')
  assert.equal(initialSource('', null), 'dandi')
})
