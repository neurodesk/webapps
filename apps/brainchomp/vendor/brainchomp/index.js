// src/error.ts
var BrainchompError = class extends Error {
  code;
  /** The module's own output, when the failure came from inside it. */
  log;
  constructor(code, message, log) {
    super(message);
    this.name = "BrainchompError";
    this.code = code;
    this.log = log;
  }
};

// src/device.ts
var CHANNEL_STRIDE = 16;
var ACTIVATION_BYTES = 256 * 256 * 256 * CHANNEL_STRIDE * 2;
var WANT_BYTES = Math.max(1024 * 1024 * 1024, 2 * ACTIVATION_BYTES);
var MiB = (n) => `${Math.round(n / (1024 * 1024))} MiB`;
var NO_GPU = "navigator.gpu is undefined: either this browser has no WebGPU, or the page is not a secure context. about:blank and file:// are NOT secure contexts and look exactly like a browser without WebGPU; serve over https or localhost.";
async function checkSupport() {
  if (typeof navigator === "undefined" || !navigator.gpu)
    return { supported: false, reasons: [NO_GPU] };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { supported: false, reasons: ["requestAdapter returned null"] };
  const reasons = [];
  const hasShaderF16 = adapter.features.has("shader-f16");
  const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
  if (!hasShaderF16)
    reasons.push(
      "the adapter does not support the shader-f16 feature, which the kernels require; an f32 path would need more than 2 GiB of activations"
    );
  if (maxStorageBufferBindingSize < ACTIVATION_BYTES)
    reasons.push(
      `maxStorageBufferBindingSize is ${MiB(maxStorageBufferBindingSize)}, but one activation buffer needs ${MiB(ACTIVATION_BYTES)}`
    );
  if (maxBufferSize < ACTIVATION_BYTES)
    reasons.push(
      `maxBufferSize is ${MiB(maxBufferSize)}, but one activation buffer needs ${MiB(ACTIVATION_BYTES)}`
    );
  return {
    supported: reasons.length === 0,
    reasons,
    maxBufferSize,
    maxStorageBufferBindingSize,
    hasShaderF16
  };
}
async function acquireDevice() {
  if (typeof navigator === "undefined" || !navigator.gpu)
    throw new BrainchompError("no-webgpu", NO_GPU);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new BrainchompError("no-adapter", "requestAdapter returned null");
  if (!adapter.features.has("shader-f16"))
    throw new BrainchompError(
      "no-f16",
      "this adapter lacks the shader-f16 feature, which the segmentation kernels require"
    );
  const maxBufferSize = Math.min(WANT_BYTES, adapter.limits.maxBufferSize);
  const maxStorageBufferBindingSize = Math.min(WANT_BYTES, adapter.limits.maxStorageBufferBindingSize);
  if (maxStorageBufferBindingSize < ACTIVATION_BYTES || maxBufferSize < ACTIVATION_BYTES)
    throw new BrainchompError(
      "device-too-small",
      `this device allows ${MiB(maxStorageBufferBindingSize)} per storage binding and ${MiB(maxBufferSize)} per buffer, but the model needs ${MiB(ACTIVATION_BYTES)} for a single activation`
    );
  return adapter.requestDevice({
    requiredFeatures: ["shader-f16"],
    requiredLimits: { maxBufferSize, maxStorageBufferBindingSize }
  });
}
function checkDevice(device) {
  const { maxStorageBufferBindingSize, maxBufferSize } = device.limits;
  if (maxStorageBufferBindingSize < ACTIVATION_BYTES || maxBufferSize < ACTIVATION_BYTES)
    throw new BrainchompError(
      "device-too-small",
      `the supplied device allows ${MiB(maxStorageBufferBindingSize)} per storage binding and ${MiB(maxBufferSize)} per buffer, but the model needs ${MiB(ACTIVATION_BYTES)} for a single activation. Request it with acquireDevice(), which asks for the right limits.`
    );
  if (!device.features.has("shader-f16"))
    throw new BrainchompError(
      "no-f16",
      "the supplied device was created without the shader-f16 feature, which the segmentation kernels require"
    );
}

// src/webgl2.ts
var GL_ACTIVATION_BYTES = ACTIVATION_BYTES * 2;
var DIM = 256;
var PLANE_BYTES = DIM * DIM * DIM * 4 * 2;
var LABEL_W = 2048;
var MiB2 = (n) => `${Math.round(n / (1024 * 1024))} MiB`;
function newContext() {
  const canvas = typeof OffscreenCanvas !== "undefined" && typeof document === "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  return canvas.getContext("webgl2", {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance"
  });
}
function checkWebgl2Support() {
  const gl = newContext();
  if (!gl)
    return {
      supported: false,
      reasons: ["a webgl2 context could not be created; this browser is either too old or has WebGL disabled or blocklisted"]
    };
  const reasons = [];
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const float = gl.getExtension("EXT_color_buffer_float");
  if (!float)
    reasons.push("this device lacks EXT_color_buffer_float, which the kernels require in order to render into float textures");
  const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  const drawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  const attachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if (max3d < DIM)
    reasons.push(`MAX_3D_TEXTURE_SIZE is ${max3d}, but the model needs ${DIM}`);
  const planes = ACTIVATION_BYTES / PLANE_BYTES;
  if (drawBuffers < planes || attachments < planes)
    reasons.push(`this device allows ${drawBuffers} draw buffers and ${attachments} colour attachments, but the model writes ${planes} at once`);
  if (maxTexture < LABEL_W || viewport[0] < LABEL_W || viewport[1] < LABEL_W)
    reasons.push(`MAX_TEXTURE_SIZE is ${maxTexture} and MAX_VIEWPORT_DIMS ${viewport[0]}x${viewport[1]}, but the label texture is ${LABEL_W}x${LABEL_W}`);
  let allocates;
  if (float && max3d >= DIM) {
    while (gl.getError() !== gl.NO_ERROR) {
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, DIM, DIM, DIM);
    allocates = gl.getError() === gl.NO_ERROR && !gl.isContextLost();
    gl.deleteTexture(tex);
    if (!allocates)
      reasons.push(`this device could not allocate even one ${MiB2(PLANE_BYTES)} activation plane; a run needs ${MiB2(GL_ACTIVATION_BYTES)} of them`);
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    supported: reasons.length === 0,
    reasons,
    renderer,
    max3dTextureSize: max3d,
    maxDrawBuffers: drawBuffers,
    maxColorAttachments: attachments,
    maxTextureSize: maxTexture,
    allocates
  };
}
function releaseGlContext(gl) {
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}
function acquireGlContext() {
  const gl = newContext();
  if (!gl)
    throw new BrainchompError(
      "no-webgpu",
      "a webgl2 context could not be created; this browser is either too old or has WebGL disabled or blocklisted"
    );
  if (!gl.getExtension("EXT_color_buffer_float"))
    throw new BrainchompError(
      "no-f16",
      "this device lacks EXT_color_buffer_float, which the segmentation kernels require in order to render into float textures"
    );
  const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  if (max3d < DIM)
    throw new BrainchompError(
      "device-too-small",
      `this device allows 3D textures up to ${max3d}, but the model needs ${DIM}`
    );
  return gl;
}

// src/gzip.ts
var GZIP_MAGIC = [31, 139];
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}
async function through(bytes, stream) {
  const copy = new Uint8Array(bytes);
  const body = new Blob([copy]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined")
    throw new BrainchompError(
      "bad-input",
      "the input is gzipped but this environment has no DecompressionStream; decompress it before calling, or pass an uncompressed NIfTI"
    );
  return through(bytes, new DecompressionStream("gzip"));
}
async function gzip(bytes) {
  if (typeof CompressionStream === "undefined")
    throw new BrainchompError(
      "bad-input",
      "gzip output was requested but this environment has no CompressionStream"
    );
  return through(bytes, new CompressionStream("gzip"));
}

// src/run.ts
var DEFAULT_TIMEOUT_MS = 12e4;
var INITIALIZATION_TIMEOUT_MS = 12e4;
var CPU_TIMEOUT_MS = 9e5;
var MODULE_FILE = {
  webgpu: "./brainchomp-gpu.js",
  webgl2: "./brainchomp-gl.js",
  // No suffix: the CPU module is the only one built with -pthread.
  cpu: "./brainchomp.js"
};
var factories = /* @__PURE__ */ new Map();
function assetUrl(file, assetPath) {
  if (!assetPath) return new URL(file, import.meta.url).href;
  const base = assetPath.endsWith("/") ? assetPath : `${assetPath}/`;
  const here = typeof location !== "undefined" ? location.href : "file:///";
  const url = new URL(`${base}${file.replace("./", "")}`, here);
  if (typeof location !== "undefined") {
    if (location.origin === "null")
      throw new BrainchompError(
        "unsupported-option",
        "assetPath cannot be used from an opaque origin (file:// or a sandboxed iframe); serve the page over http(s)"
      );
    if (url.origin !== location.origin)
      throw new BrainchompError(
        "unsupported-option",
        `assetPath must be same-origin; ${url.origin} is not ${location.origin}`
      );
  }
  return url.href;
}
function moduleUrl(backend, assetPath) {
  return assetUrl(MODULE_FILE[backend], assetPath);
}
function loadFactory(url) {
  let pending = factories.get(url);
  if (!pending) {
    pending = import(
      /* @vite-ignore */
      url
    ).then((m) => m.default);
    factories.set(url, pending);
    void pending.catch(() => {
      if (factories.get(url) === pending) factories.delete(url);
    });
  }
  return pending;
}
async function run(request) {
  const log = [];
  const record = (line) => {
    log.push(line);
    request.onLog?.(line);
  };
  let settle;
  const exited = new Promise((resolve) => {
    settle = resolve;
  });
  let timer;
  const config = {
    noInitialRun: true,
    // bm_cli_parse takes the program name from argv[0]; without this the module
    // would identify itself as whatever host script loaded it.
    thisProgram: "brainchomp",
    print: record,
    printErr: record,
    onExit: (code2) => settle(code2)
  };
  if (request.backend === "webgpu") {
    config.preinitializedWebGPUDevice = request.device;
  } else if (request.backend === "webgl2") {
    config.preinitializedWebGLContext = request.glContext;
  }
  const limit = request.timeoutMs ?? (request.backend === "cpu" ? CPU_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const initializationLimit = Math.min(limit, INITIALIZATION_TIMEOUT_MS);
  const url = moduleUrl(request.backend, request.assetPath);
  const factoryPromise = loadFactory(url);
  let initializationTimedOut = false;
  const module = await Promise.race([
    factoryPromise.then((createModule) => createModule(config)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        initializationTimedOut = true;
        reject(new BrainchompError(
          "initialization-failed",
          `the ${request.backend} module did not finish initialising within ${initializationLimit} ms`,
          log
        ));
      }, initializationLimit);
    })
  ]).finally(() => {
    clearTimeout(timer);
    if (initializationTimedOut && factories.get(url) === factoryPromise) factories.delete(url);
  });
  if (request.backend === "webgl2") {
    if (!module.specialHTMLTargets)
      throw new BrainchompError(
        "inference-failed",
        "this WebGL2 module was built without specialHTMLTargets exported; rebuild it with the flags in src/Makefile",
        log
      );
    module.specialHTMLTargets["#brainchomp-webgl2"] = request.glContext.canvas;
  }
  module.FS.writeFile("/in.nii", request.input);
  const started = performance.now();
  try {
    module.callMain([
      ...request.args,
      "-backend",
      request.backend,
      "-o",
      "/out.nii",
      "/in.nii"
    ]);
  } catch (e) {
    if (e && typeof e.status === "number") {
      settle(e.status);
    } else {
      record(`threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      settle(-1);
    }
  }
  const code = request.backend === "webgl2" ? await exited : await Promise.race([
    exited,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BrainchompError(
        "inference-failed",
        `the ${request.backend} module did not finish within ${limit} ms; ` + (request.backend === "cpu" ? "this machine may simply be slower than the limit allows" : "the GPU device may have been lost"),
        log
      )), limit);
    })
  ]).finally(() => clearTimeout(timer));
  const elapsedMs = performance.now() - started;
  if (request.backend === "webgl2" && request.glContext?.isContextLost())
    throw new BrainchompError(
      "inference-failed",
      "the WebGL2 context was lost during the run; the GPU or its driver reset. Any output from this run is meaningless.",
      log
    );
  if (code !== 0)
    throw new BrainchompError(
      "inference-failed",
      `the ${request.backend} module exited with status ${code}`,
      log
    );
  const primary = "/out.nii";
  if (!module.FS.analyzePath(primary).exists)
    throw new BrainchompError(
      "inference-failed",
      `the ${request.backend} module exited cleanly but wrote no output`,
      log
    );
  const extras = /* @__PURE__ */ new Map();
  for (const path of request.extraOutputs ?? [])
    if (module.FS.analyzePath(path).exists) extras.set(path, module.FS.readFile(path));
  return { image: module.FS.readFile(primary), extras, elapsedMs };
}

// src/index.ts
var MASK_PATH = "/mask.nii";
function buildArgs(options) {
  const args = ["--mask", MASK_PATH];
  if (options.opening !== void 0) {
    if (!Number.isInteger(options.opening) || options.opening < 0 || options.opening > 64)
      throw new BrainchompError(
        "unsupported-option",
        `opening must be an integer radius from 0 to 64, got ${options.opening}`
      );
    args.push("--opening", String(options.opening));
  }
  if (options.fillHoles !== void 0 && typeof options.fillHoles !== "boolean")
    throw new BrainchompError(
      "unsupported-option",
      `fillHoles must be true or false, got ${String(options.fillHoles)}`
    );
  if (options.fillHoles === false) args.push("--no-fill-holes");
  if (options.saveConform) args.push("--save-conform");
  return args;
}
async function runInWorker(input, options) {
  if (typeof Worker === "undefined")
    throw new BrainchompError(
      "unsupported-option",
      "this environment has no Worker; run with worker: false"
    );
  const url = assetUrl("worker.js", options.assetPath);
  const worker = new Worker(url, { type: "module" });
  const { device, glContext, onLog, worker: _w, ...rest } = options;
  if (rest.assetPath !== void 0) rest.assetPath = new URL("./", url).href;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "log") {
          onLog?.(message.line);
          return;
        }
        if (message.type === "done") {
          resolve({
            brain: message.brain,
            mask: message.mask,
            elapsedMs: message.elapsedMs,
            backend: message.backend
          });
          return;
        }
        reject(new BrainchompError(message.code, message.message, message.log));
      };
      worker.onerror = (event) => reject(new BrainchompError(
        "inference-failed",
        `the segmentation worker failed to start or threw: ${event.message ?? "unknown"}`
      ));
      worker.onmessageerror = () => reject(new BrainchompError(
        "inference-failed",
        "the segmentation worker sent a message that could not be deserialized"
      ));
      const named = options.backend && options.backend !== "auto" ? options.backend : null;
      const limit = options.timeoutMs ?? (named && named !== "cpu" ? 12e4 : CPU_TIMEOUT_MS);
      timer = setTimeout(() => reject(new BrainchompError(
        "inference-failed",
        `the segmentation did not finish within ${limit} ms`
      )), limit);
      worker.postMessage({ input, options: rest });
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}
async function acquire(options) {
  const named = options.backend && options.backend !== "auto" ? options.backend : null;
  if (options.device && named && named !== "webgpu")
    throw new BrainchompError(
      "unsupported-option",
      `backend: '${named}' was requested but a GPUDevice was supplied; a device selects the webgpu backend. Drop the device, or drop the backend.`
    );
  if (options.glContext && named && named !== "webgl2")
    throw new BrainchompError(
      "unsupported-option",
      `backend: '${named}' was requested but a WebGL2RenderingContext was supplied; a context selects the webgl2 backend. Drop the glContext, or drop the backend.`
    );
  if (options.device) {
    checkDevice(options.device);
    return { backend: "webgpu", device: options.device, ownsContext: false };
  }
  if (options.glContext)
    return { backend: "webgl2", glContext: options.glContext, ownsContext: false };
  const want = options.backend ?? "auto";
  if (want === "webgpu")
    return { backend: "webgpu", device: await acquireDevice(), ownsContext: false };
  if (want === "webgl2")
    return { backend: "webgl2", glContext: acquireGlContext(), ownsContext: true };
  if (want === "cpu") {
    const cpu2 = checkCpuSupport();
    if (!cpu2.supported)
      throw new BrainchompError("no-webgpu", `the cpu backend cannot run here: ${cpu2.reasons.join("; ")}`);
    return { backend: "cpu", ownsContext: false };
  }
  const gpu = await checkSupport();
  if (gpu.supported)
    return { backend: "webgpu", device: await acquireDevice(), ownsContext: false };
  const gl = checkWebgl2Support();
  if (gl.supported)
    return { backend: "webgl2", glContext: acquireGlContext(), ownsContext: true };
  const cpu = checkCpuSupport();
  if (cpu.supported) return { backend: "cpu", ownsContext: false };
  throw new BrainchompError(
    "no-webgpu",
    `no backend can run here.
  WebGPU: ${gpu.reasons.join("; ")}
  WebGL2: ${gl.reasons.join("; ")}
  CPU:    ${cpu.reasons.join("; ")}`
  );
}
function checkCpuSupport() {
  const reasons = [];
  if (typeof SharedArrayBuffer === "undefined")
    reasons.push("this environment has no SharedArrayBuffer");
  else if (globalThis.crossOriginIsolated !== true)
    reasons.push("this page is not cross-origin isolated; serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp");
  return { supported: reasons.length === 0, reasons };
}
async function segment(input, options = {}) {
  const raw = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (raw.byteLength === 0)
    throw new BrainchompError("bad-input", "the input is empty");
  const args = buildArgs(options);
  if (options.worker && (options.device || options.glContext))
    throw new BrainchompError(
      "unsupported-option",
      "worker cannot be combined with device or glContext: a GPUDevice and a WebGL2RenderingContext belong to the thread that created them and cannot cross into a worker"
    );
  if (options.worker) {
    const out = await runInWorker(raw, options);
    return { ...out, ranInWorker: true };
  }
  const compressed = isGzip(raw);
  const bytes = compressed ? await gunzip(raw) : raw;
  const wantGzip = options.gzipOutput ?? compressed;
  const { backend, device, glContext, ownsContext } = await acquire(options);
  let result;
  try {
    result = await run({
      backend,
      device,
      glContext,
      input: bytes,
      args,
      extraOutputs: [MASK_PATH],
      assetPath: options.assetPath,
      timeoutMs: options.timeoutMs,
      onLog: options.onLog
    });
  } finally {
    if (ownsContext && glContext) releaseGlContext(glContext);
  }
  const mask = result.extras.get(MASK_PATH);
  if (!mask)
    throw new BrainchompError("inference-failed", "the module wrote no brain mask", []);
  const pack = async (data) => {
    const out = wantGzip ? await gzip(data) : data;
    return out.slice().buffer;
  };
  return {
    brain: await pack(result.image),
    mask: await pack(mask),
    elapsedMs: result.elapsedMs,
    backend,
    ranInWorker: false
  };
}
export {
  ACTIVATION_BYTES,
  BrainchompError,
  GL_ACTIVATION_BYTES,
  acquireDevice,
  acquireGlContext,
  checkCpuSupport,
  checkSupport,
  checkWebgl2Support,
  releaseGlContext,
  segment
};
//# sourceMappingURL=index.js.map
