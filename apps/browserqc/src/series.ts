export async function describeSeries(images: File[], sidecars: File[], fallback: unknown) {
  return Promise.all(images.map(async file => {
    const stem = file.name.replace(/\.(nii(\.gz)?|mgz|mgh)$/i, '')
    const sidecar = sidecars.find(candidate => candidate.name.toLowerCase() === `${stem}.json`.toLowerCase())
    const meta: unknown = sidecar
      ? await sidecar.text().then(JSON.parse).catch(() => null)
      : images.length === 1 ? fallback : null
    const description = meta && typeof meta === 'object' && 'SeriesDescription' in meta && typeof meta.SeriesDescription === 'string'
      ? meta.SeriesDescription : stem
    const number = meta && typeof meta === 'object' && 'SeriesNumber' in meta && typeof meta.SeriesNumber === 'number'
      ? meta.SeriesNumber : null
    return { file, meta, label: number === null ? description : `${number} · ${description} · ${stem}` }
  }))
}
