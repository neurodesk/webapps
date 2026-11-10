export type OmezarrSourceId = 'dandi' | 'custom'

const DEFAULT_SOURCE: OmezarrSourceId = 'dandi'

// DANDI is a neuroscience archive; other catalogues open on a plain OME-Zarr URL.
const CATALOG_DEFAULT_SOURCES: Readonly<Record<string, OmezarrSourceId>> = {
  microscopy: 'custom',
}

export function isOmezarrSourceId(value: string): value is OmezarrSourceId {
  return value === 'dandi' || value === 'custom'
}

export function hostingCatalog(doc: Document): string | null {
  return doc.documentElement.getAttribute('data-neurodesk-catalog')
}

export function initialSource(
  requested: string | null,
  catalogId: string | null,
): OmezarrSourceId {
  if (requested && isOmezarrSourceId(requested)) return requested
  if (catalogId && Object.hasOwn(CATALOG_DEFAULT_SOURCES, catalogId)) {
    return CATALOG_DEFAULT_SOURCES[catalogId]!
  }
  return DEFAULT_SOURCE
}
