// Stand-in for web/nifti-js/index.js, the UMD build of nifti-reader-js that
// installs `globalThis.nifti` in the browser. Same library, npm entry point.
import * as nifti from 'nifti-reader-js';

globalThis.nifti = nifti;
