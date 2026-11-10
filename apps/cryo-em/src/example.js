// The RELION tutorial example (EMPIAR-10204 subset, CC0). Its movies are too
// large for a browser: `neurodesk-compute fetch-example relion-tutorial` puts
// them in the server's `examples` data root, and the app downloads only the
// pinned SHA256SUMS that lists them. The settings are the RELION 5 tutorial's.

export const EXAMPLE_ROOT = 'examples';
const MOVIES = 'relion-tutorial/Movies';

export const EXAMPLE_SETTINGS = Object.freeze({
  import: {
    inputs: { movies: { root: EXAMPLE_ROOT, path: MOVIES, pattern: '*.tiff' } },
    options: { angpix: 0.885, kV: 200, Cs: 1.4 },
  },
  motioncorr: {
    inputs: { gain: { root: EXAMPLE_ROOT, path: `${MOVIES}/gain.mrc` } },
    options: { dosePerFrame: 1.277, patchX: 5, patchY: 5 },
  },
  autopick: { options: { logDiamMin: 150, logDiamMax: 180 } },
  extract: { options: { extractSize: 256, doRescale: true, rescale: 64 } },
  class2d: { options: { nrClasses: 50 } },
  initialmodel: { options: { sym: 'D2' } },
  refine3d: { options: { sym: 'D2' } },
});

/** The tutorial's movie names from its SHA256SUMS (`{ path: sha256 }`). */
export function exampleMovies(checksums) {
  const movies = Object.keys(checksums)
    .filter(path => path.startsWith('Movies/') && path.endsWith('.tiff'))
    .map(path => path.slice('Movies/'.length));
  if (!movies.length || !checksums['Movies/gain.mrc']) throw new Error('SHA256SUMS does not list the tutorial movies and gain reference');
  return movies.sort();
}
