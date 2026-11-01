/**
 * What a failed engine call says, as the page reports it: the part of upstream's
 * js/next/engine/engine-call.js (`describeFailure`) the run worker uses. The next.html preview
 * is not imported (apps/qsmbly/upstream.json), so upstream's import of that file is rewritten
 * to this one.
 *
 * - A failed run (the engine's own error) is reported as it is.
 * - A call that dies inside the WASM module (a Rust panic, which aborts: the build is
 *   `panic=abort`) throws a `WebAssembly.RuntimeError` ("unreachable"). The panic's own message
 *   is asked of the module (`take_panic_wasm`).
 */

/**
 * @typedef {{ message: string, kind: string | null, fatal: boolean }} Failure
 * @typedef {{ take_panic_wasm?: () => string | undefined }} PanicSource
 */

/**
 * @param {unknown} e
 * @param {{ mod?: PanicSource | null }} [context] the module the call was into, for its panic message
 * @returns {Failure}
 */
export function describeFailure(e, { mod = null } = {}) {
  const err = /** @type {any} */ (e);
  const trapped = typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError;
  if (!trapped) {
    return {
      message: err instanceof Error ? err.message : String(err),
      kind: err?.kind ?? null,
      fatal: false,
    };
  }
  let panic;
  try {
    panic = mod?.take_panic_wasm?.();
  } catch {
    panic = undefined;
  }
  const message = panic ? `The engine panicked: ${panic}` : `The engine stopped (${err.message})`;
  return { message, kind: panic ? 'panic' : 'abort', fatal: true };
}

/** Run a call and free the engine without letting cleanup replace a trap's cause. */
export function withEngine(engine, use, mod) {
  let result;
  try {
    result = use(engine);
  } catch (error) {
    const failure = describeFailure(error, { mod });
    try {
      engine.free();
    } catch {
      // A trapped call leaves the Rust value borrowed; preserve the failure for the controller.
    }
    const reported = failure.fatal || !(error instanceof Error) ? new Error(failure.message, { cause: error }) : error;
    throw Object.assign(reported, failure);
  }
  engine.free();
  return result;
}
