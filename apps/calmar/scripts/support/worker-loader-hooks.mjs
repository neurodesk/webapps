// Node module-loader hooks that let the browser module worker
// (web/js/inference-worker.js) be imported under Node unchanged.
//
// The worker's browser-only imports are generated at build time and are not
// in the repository, so each is redirected to its source of truth:
//   web/vendor/webapp-components/src/*  -> packages/components/src/*
//       (scripts/vendor-components.mjs copies exactly this directory)
//   web/nifti-js/index.js               -> the nifti-reader-js package
//   web/wasm/ort.webgpu.bundle.min.mjs  -> scripts/support/ort-stub.mjs
// Only ONNX Runtime is replaced by a stand-in; everything else is real code.

const WEB = new URL('../../web/', import.meta.url).href;
const COMPONENTS = new URL('../../../../packages/components/src/', import.meta.url).href;
const VENDOR = `${WEB}vendor/webapp-components/src/`;
const REDIRECTS = new Map([
  [`${WEB}wasm/ort.webgpu.bundle.min.mjs`, new URL('./ort-stub.mjs', import.meta.url).href],
  [`${WEB}nifti-js/index.js`, new URL('./nifti-global.mjs', import.meta.url).href]
]);

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && specifier.startsWith('.')) {
    const target = new URL(specifier, context.parentURL).href;
    if (REDIRECTS.has(target)) {
      return { url: REDIRECTS.get(target), shortCircuit: true };
    }
    if (target.startsWith(VENDOR)) {
      return { url: COMPONENTS + target.slice(VENDOR.length), shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
