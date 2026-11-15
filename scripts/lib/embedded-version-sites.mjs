// Version strings that live outside package.json. Each app that embeds its
// version registers a site here; test/app-versions.test.mjs checks they agree.
export const EMBEDDED_VERSION_SITES = Object.freeze({
  'omezarr-convert': [
    { file: 'apps/omezarr-convert/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  'microscope-qc': [
    { file: 'apps/microscope-qc/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  hmc: [
    { file: 'apps/hmc/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  brain2print: [
    { file: 'apps/brain2print/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  nesvor: [
    { file: 'apps/nesvor/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  dwidenoise: [
    { file: 'apps/dwidenoise/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  degibbs: [
    { file: 'apps/degibbs/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  n4: [
    { file: 'apps/n4/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  noddi: [
    { file: 'apps/noddi/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  'calcium-imaging': [
    { file: 'apps/calcium-imaging/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  'cryo-em': [
    { file: 'apps/cryo-em/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  stitching: [
    { file: 'apps/stitching/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  histo2mri: [
    { file: 'apps/histo2mri/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  dwicorrect: [
    { file: 'apps/dwicorrect/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  qsmbly: [
    { file: 'apps/qsmbly/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
    { file: 'apps/qsmbly/rust-wasm/Cargo.toml', pattern: /(name = "qsm_wasm"\nversion = ")[^"]+("\n)/, replace: '$1{version}$2' },
    { file: 'apps/qsmbly/rust-wasm/Cargo.lock', pattern: /(name = "qsm_wasm"\nversion = ")[^"]+("\n)/, replace: '$1{version}$2' },
  ],
  vesselboost: [
    { file: 'apps/vesselboost/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  seedseg: [
    { file: 'apps/seedseg/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  spinalcordtoolbox: [
    { file: 'apps/spinalcordtoolbox/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  calmar: [
    { file: 'apps/calmar/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  dicompare: [
    { file: 'apps/dicompare/src/version.ts', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  greedy: [
    { file: 'exes/greedy/Cargo.toml', pattern: /(^\[workspace\.package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/greedy/Cargo.lock', pattern: /(name = "greedy-rs"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  musclemap: [
    { file: 'apps/musclemap/model-sources/release.json', pattern: /("appVersion":\s*")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/model-sources/release.json', pattern: /("targetAppVersion":\s*")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/web/js/app/model-catalog.generated.js', pattern: /(export const APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/web/js/app/model-catalog.generated.js', pattern: /(export const TARGET_APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'packages/musclemap/src/model-catalog.generated.js', pattern: /(export const APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'packages/musclemap/src/model-catalog.generated.js', pattern: /(export const TARGET_APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  zarro: [
    { file: 'apps/zarro/src/config.js', pattern: /(version: ')[^']+(')/, replace: '$1{version}$2' },
  ],
  synthseg: [
    { file: 'exes/synthseg/Cargo.toml', pattern: /(^\[package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/synthseg/Cargo.lock', pattern: /(name = "synthseg"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'packages/synthseg/src/pipeline.js', pattern: /(const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
    { file: 'apps/synthseg/src/inference-worker.js', pattern: /(app: 'SynthSeg web )[^']+(')/, replace: '$1{version}$2' },
  ],
  synthsr: [
    { file: 'apps/synthsr/src/inference-worker.js', pattern: /(app: 'SynthSR web )[^']+(')/, replace: '$1{version}$2' },
    { file: 'exes/synthsr/Cargo.toml', pattern: /(^\[package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/synthsr/Cargo.lock', pattern: /(name = "synthsr"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  topofit: [
    { file: 'apps/topofit/src/config.js', pattern: /(version: ')[^']+(')/, replace: '$1{version}$2' },
    { file: 'apps/topofit/src/inference-worker.js', pattern: /(app: 'TopoFit web )[^']+(')/, replace: '$1{version}$2' },
  ],
});
