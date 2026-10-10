// One elastix registration at a time, each on its own ITK-Wasm worker. Elastix
// cannot be interrupted, so cancelling rejects the run and terminates its
// worker; a cancelled run can never resolve into, or hide the cancel control
// of, the run after it. ITK-Wasm calls are injected so Node tests use fakes.
import { buildParameterObject, stageNames } from "./parameter-maps.js";

function cancelled() {
  return new DOMException("Registration cancelled", "AbortError");
}

/**
 * An uncaught C++ exception in the elastix module rejects with a bare number
 * (a pointer); say what usually causes it instead of showing that number.
 */
export function registrationError(error) {
  if (typeof error === "number") {
    return new Error("elastix stopped with an internal error. Check that both images overlap and hold one scalar channel.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createRegistrationRunner({ elastix, defaultParameterMap, createWebWorker, onActiveChange = () => {} }) {
  let active = null;

  async function run({ fixed, moving, settings, parameterObject, onPhase = () => {}, signal }) {
    signal?.throwIfAborted();
    if (active) throw new Error("A registration is already running.");
    let worker = null;
    let closed = false;
    let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const job = {};
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", stop);
      worker?.terminate();
      if (active === job) {
        active = null;
        onActiveChange(false);
      }
    };
    const stop = () => {
      rejectStop(signal?.aborted ? signal.reason : cancelled());
      close();
    };
    job.cancel = stop;
    active = job;
    onActiveChange(true);
    signal?.addEventListener("abort", stop, { once: true });

    const work = (async () => {
      worker = await createWebWorker();
      if (closed) {
        worker.terminate();
        throw cancelled();
      }
      let maps = parameterObject;
      if (!maps) {
        onPhase("Building elastix parameter maps");
        ({ parameterObject: maps, webWorker: worker } = await buildParameterObject(settings, { defaultParameterMap, webWorker: worker }));
      }
      if (closed) throw cancelled();
      onPhase(`Registering with elastix · ${stageNames(maps).join(" → ")}`);
      const { result, transform, transformParameterObject } = await elastix(maps, { fixed, moving, webWorker: worker });
      return { result, transform, transformParameterObject, parameterObject: maps };
    })();
    // A terminated worker leaves its pipeline promise pending or rejected; nobody awaits it after a stop.
    work.catch(() => {});
    try {
      return await Promise.race([work, stopped]);
    } catch (error) {
      throw error?.name === "AbortError" ? error : registrationError(error);
    } finally {
      close();
    }
  }

  return {
    run,
    cancel: () => active?.cancel(),
    get active() {
      return Boolean(active);
    },
  };
}
