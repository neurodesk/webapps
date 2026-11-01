// WebGPU kernels for PyHySCO's Gauss-Newton evaluations and its Jacobi-preconditioned CG.
//
// The `sdc_gpu` imports of ./sdc.wasm (exes/sdc/wasm, `pyhysco_webgpu`) call these functions.
// The WebAssembly keeps the input checks, the initialization, the Gauss-Newton control flow, the
// line search and the conversion to Hz. Here the objective, its gradient, the Gauss-Newton terms
// and the CG solve run in float32 on the GPU. Every sum ends as one float32 partial per
// workgroup; JavaScript adds the partials in float64 and makes each CG decision (step, stop) in
// float64, in PyHySCO's order. Each kernel follows the function of exes/sdc/core/src/hysco.rs
// that its comment names.

import { isSoftwareAdapter } from "@neurodesk/runtime-support/mindgrab/backend";

const WORKGROUP = 256;
const MAX_GROUPS_X = 65535;

// Partial-sum slots, one row of `groups` float32 values each.
const SLOT = { residual: 0, barrier: 1, smooth: 2, curvature: 3, residualNorm: 4, zr: 5 };
const SLOTS = 6;

const HEADER = /* wgsl */ `
struct Params {
  m0: u32, m1: u32, m2: u32, linearize: u32,
  cells: u32, nodes: u32, groups: u32, pad0: u32,
  h2: f32, hd: f32, hdAlpha: f32, hdBeta: f32,
  w0: f32, w1: f32, w2: f32, wc: f32,
  diff0: f32, diff1: f32, step: f32, cgBeta: f32,
  diagConst: f32, ad0: f32, ad1: f32, d20: f32,
  d21: f32, pad1: f32, pad2: f32, pad3: f32,
}
@group(0) @binding(0) var<uniform> P: Params;

fn flatIndex(wid: vec3<u32>, nwg: vec3<u32>, lid: u32) -> u32 {
  return (wid.y * nwg.x + wid.x) * ${WORKGROUP}u + lid;
}

// Conv1D.transp_mat_mul with the two-tap kernel (k0, k1): cells to nodes along the PE axis.
// c0 is the cell at the node's index, c1 the cell before it.
fn convT(k0: f32, k1: f32, c0: f32, c1: f32, j: u32) -> f32 {
  var s = 0.0;
  if (j < P.m2) {
    s = k0 * c0;
  }
  if (j > 0u) {
    s = s + k1 * c1;
  }
  return s;
}
`;

// A workgroup tree sum of two values, written to the partial rows of two slots. With one slot,
// only the first value is written.
const REDUCE = /* wgsl */ `
var<workgroup> partial: array<vec2<f32>, ${WORKGROUP}>;

fn reduceTwo(lid: u32, group: u32, value: vec2<f32>, slotA: u32, slotB: u32) {
  partial[lid] = value;
  workgroupBarrier();
  for (var s = ${WORKGROUP / 2}u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      partial[lid] = partial[lid] + partial[lid + s];
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    partials[slotA * P.groups + group] = partial[0].x;
    if (slotB != slotA) {
      partials[slotB * P.groups + group] = partial[0].y;
    }
  }
}
`;

// The cell values at the node's index and before it, in the row that starts at `base` of
// `array`, or 0 outside the row's m2 cells.
const CELL_PAIR = (array) => /* wgsl */ `
fn ${array}Pair(base: u32, j: u32) -> vec2<f32> {
  var here = 0.0;
  var before = 0.0;
  if (j < P.m2) {
    here = ${array}[base + j];
  }
  if (j > 0u) {
    before = ${array}[base + j - 1u];
  }
  return vec2<f32>(here, before);
}
`;

// myLaplacian3D on the node grid, zero padded, taps in conv3d's order.
const LAPLACIAN = (array) => /* wgsl */ `
fn laplacian(k: u32) -> f32 {
  let n2 = P.m2 + 1u;
  let n1 = P.m1;
  let n0 = P.m0;
  let lc = k % n2;
  let lb = (k / n2) % n1;
  let la = k / (n2 * n1);
  var s = 0.0;
  if (la > 0u) {
    s = s + -P.w0 * ${array}[k - n1 * n2];
  }
  if (lb > 0u) {
    s = s + -P.w1 * ${array}[k - n2];
  }
  if (lc > 0u) {
    s = s + -P.w2 * ${array}[k - 1u];
  }
  s = s + P.wc * ${array}[k];
  if (lc + 1u < n2) {
    s = s + -P.w2 * ${array}[k + 1u];
  }
  if (lb + 1u < n1) {
    s = s + -P.w1 * ${array}[k + n2];
  }
  if (la + 1u < n0) {
    s = s + -P.w0 * ${array}[k + n1 * n2];
  }
  return s;
}
`;

const ENTRY = /* wgsl */ `@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) lid: u32)`;

// Layout of the `lin` buffer: six cell arrays.
const LIN = { geom: 0, intensity: 1, d2g: 2, t1: 3, t2: 4, dgv: 5 };

const SHADERS = {
  // Problem::eval, the cell part: interpolation, the corrected images, the residual, the
  // barrier phi_EPI and the terms of the gradient and of the Hessian.
  evalCells: /* wgsl */ `
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read> images: array<f32>;
@group(0) @binding(3) var<storage, read> centres: array<f32>;
@group(0) @binding(4) var<storage, read_write> corr: array<f32>;
@group(0) @binding(5) var<storage, read_write> lin: array<f32>;
@group(0) @binding(6) var<storage, read_write> partials: array<f32>;
${HEADER}
${REDUCE}
fn interp(offset: u32, row: u32, x: f32) -> vec2<f32> {
  let n = P.m2;
  let last = f32(n - 1u);
  let s = clamp(x / P.h2 - 0.5, 0.0, last);
  let p = floor(s);
  let f = s - p;
  let pl = u32(p);
  let pr = min(pl + 1u, n - 1u);
  let yl = images[offset + row * n + pl];
  let yr = images[offset + row * n + pr];
  return vec2<f32>(yl * (1.0 - f) + yr * f, (yr - yl) / P.h2);
}
fn phi(x: f32) -> vec3<f32> {
  if (abs(x) >= 1.0) {
    return vec3<f32>(0.0);
  }
  let x2 = x * x;
  let q = x2 - 1.0;
  let g = -(x2 * x2) / q;
  let dg = -2.0 * (x * x2) * (x2 - 2.0) / (q * q);
  let d2g = -2.0 * x2 * (x2 * x2 - 3.0 * x2 + 6.0) / (q * q * q);
  return vec3<f32>(g, dg, d2g);
}
${ENTRY} {
  let k = flatIndex(wid, nwg, lid);
  var sums = vec2<f32>(0.0);
  if (k < P.cells) {
    let n = P.m2;
    let row = k / n;
    let i = k % n;
    let node = row * (n + 1u) + i;
    let bc = 0.5 * b[node] + 0.5 * b[node + 1u];
    let dbc = P.diff0 * b[node] + P.diff1 * b[node + 1u];
    let x1 = centres[i] + bc;
    let x2 = centres[i] - bc;
    let f1 = interp(0u, row, x1);
    let f2 = interp(P.cells, row, x2);
    let jac1 = 1.0 + dbc;
    let jac2 = 1.0 - dbc;
    let c1 = f1.x * jac1;
    let c2 = f2.x * jac2;
    corr[k] = c1;
    corr[P.cells + k] = c2;
    let rc = c1 - c2;
    let ph = phi(jac1 - 1.0);
    sums = vec2<f32>(rc * rc, ph.x);
    if (P.linearize == 1u) {
      let geom = f1.x + f2.x;
      let intensity = (1.0 + dbc) * f1.y + (1.0 - dbc) * f2.y;
      let ddc = rc * P.hd;
      lin[${LIN.geom}u * P.cells + k] = geom;
      lin[${LIN.intensity}u * P.cells + k] = intensity;
      lin[${LIN.d2g}u * P.cells + k] = ph.z;
      lin[${LIN.t1}u * P.cells + k] = ddc * geom;
      lin[${LIN.t2}u * P.cells + k] = ddc * intensity;
      lin[${LIN.dgv}u * P.cells + k] = ph.y;
    }
  }
  reduceTwo(lid, wid.y * nwg.x + wid.x, sums, ${SLOT.residual}u, ${SLOT.barrier}u);
}
`,

  // Problem::eval, the node part: the smoothness term, the gradient and JacobiCG.getM.
  evalNodes: /* wgsl */ `
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read> lin: array<f32>;
@group(0) @binding(3) var<storage, read_write> grad: array<f32>;
@group(0) @binding(4) var<storage, read_write> diag: array<f32>;
@group(0) @binding(5) var<storage, read_write> partials: array<f32>;
${HEADER}
${REDUCE}
${LAPLACIAN("b")}
${CELL_PAIR("lin")}
fn cellPair(slot: u32, base: u32, j: u32) -> vec2<f32> {
  return linPair(slot * P.cells + base, j);
}
${ENTRY} {
  let k = flatIndex(wid, nwg, lid);
  var sums = vec2<f32>(0.0);
  if (k < P.nodes) {
    let lb = laplacian(k);
    sums = vec2<f32>(b[k] * lb, 0.0);
    if (P.linearize == 1u) {
      let n = P.m2;
      let row = k / (n + 1u);
      let j = k % (n + 1u);
      let base = row * n;
      let t1 = cellPair(${LIN.t1}u, base, j);
      let t2 = cellPair(${LIN.t2}u, base, j);
      let dgv = cellPair(${LIN.dgv}u, base, j);
      let dd = convT(P.diff0, P.diff1, t1.x, t1.y, j);
      let tmp = convT(0.5, 0.5, t2.x, t2.y, j);
      let dp = convT(P.diff0, P.diff1, dgv.x, dgv.y, j);
      grad[k] = (dd + tmp) + P.hdAlpha * lb + P.hdBeta * dp;
      let g = cellPair(${LIN.geom}u, base, j);
      let it = cellPair(${LIN.intensity}u, base, j);
      let d2g = cellPair(${LIN.d2g}u, base, j);
      let p1 = convT(P.ad0, P.ad1, g.x * it.x, g.y * it.y, j);
      let p2 = convT(0.25, 0.25, it.x * it.x, it.y * it.y, j);
      let p3 = convT(P.d20, P.d21, g.x * g.x, g.y * g.y, j);
      let p4 = convT(P.d20, P.d21, d2g.x, d2g.y, j);
      let diagD = 2.0 * p1 + p2 + p3;
      diag[k] = P.hd * diagD + P.hdBeta * p4 + P.diagConst;
    }
  }
  reduceTwo(lid, wid.y * nwg.x + wid.x, sums, ${SLOT.smooth}u, ${SLOT.smooth}u);
}
`,

  // Problem::hessian, the cell part.
  hessCells: /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> lin: array<f32>;
@group(0) @binding(3) var<storage, read_write> uv: array<f32>;
${HEADER}
${ENTRY} {
  let k = flatIndex(wid, nwg, lid);
  if (k < P.cells) {
    let n = P.m2;
    let node = (k / n) * (n + 1u) + k % n;
    let dx = P.diff0 * x[node] + P.diff1 * x[node + 1u];
    let ax = 0.5 * x[node] + 0.5 * x[node + 1u];
    let geom = lin[${LIN.geom}u * P.cells + k];
    let intensity = lin[${LIN.intensity}u * P.cells + k];
    let dr = geom * dx + intensity * ax;
    let drd = dr * P.hd;
    uv[k] = drd * geom + P.hdBeta * lin[${LIN.d2g}u * P.cells + k] * dx;
    uv[P.cells + k] = drd * intensity;
  }
}
`,

  // Problem::hessian, the node part, and the curvature p · H p of PCG.
  hessNodes: /* wgsl */ `
@group(0) @binding(1) var<storage, read> uv: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<f32>;
@group(0) @binding(3) var<storage, read_write> hx: array<f32>;
@group(0) @binding(4) var<storage, read_write> partials: array<f32>;
${HEADER}
${REDUCE}
${LAPLACIAN("x")}
${CELL_PAIR("uv")}
${ENTRY} {
  let k = flatIndex(wid, nwg, lid);
  var sums = vec2<f32>(0.0);
  if (k < P.nodes) {
    let n = P.m2;
    let row = k / (n + 1u);
    let j = k % (n + 1u);
    let u = uvPair(row * n, j);
    let v = uvPair(P.cells + row * n, j);
    let a = convT(P.diff0, P.diff1, u.x, u.y, j);
    let c = convT(0.5, 0.5, v.x, v.y, j);
    let value = (a + c) + P.hdAlpha * laplacian(k);
    hx[k] = value;
    sums = vec2<f32>(x[k] * value, 0.0);
  }
  reduceTwo(lid, wid.y * nwg.x + wid.x, sums, ${SLOT.curvature}u, ${SLOT.curvature}u);
}
`,

  // pcg: x += alpha p, r -= alpha H p, z = r / M, with |r|² and z · r.
  cgUpdate: /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> r: array<f32>;
@group(0) @binding(3) var<storage, read_write> z: array<f32>;
@group(0) @binding(4) var<storage, read> p: array<f32>;
@group(0) @binding(5) var<storage, read> hp: array<f32>;
@group(0) @binding(6) var<storage, read> diag: array<f32>;
@group(0) @binding(7) var<storage, read_write> partials: array<f32>;
${HEADER}
${REDUCE}
${ENTRY} {
  let k = flatIndex(wid, nwg, lid);
  var sums = vec2<f32>(0.0);
  if (k < P.nodes) {
    x[k] = x[k] + P.step * p[k];
    let rk = r[k] + -P.step * hp[k];
    r[k] = rk;
    let zk = rk / diag[k];
    z[k] = zk;
    sums = vec2<f32>(rk * rk, zk * rk);
  }
  reduceTwo(lid, wid.y * nwg.x + wid.x, sums, ${SLOT.residualNorm}u, ${SLOT.zr}u);
}
`,

  // pcg: p = z + beta p.
  cgDirection: /* wgsl */ `
@group(0) @binding(1) var<storage, read> z: array<f32>;
@group(0) @binding(2) var<storage, read_write> p: array<f32>;
${HEADER}
${ENTRY} {
  let k = flatIndex(wid, nwg, lid);
  if (k < P.nodes) {
    p[k] = z[k] + P.cgBeta * p[k];
  }
}
`,
};

/** WebGPU shader sources, exported for tests. */
export const shaders = SHADERS;

/**
 * A WebGPU adapter that is real hardware, or null. Software adapters (SwiftShader, llvmpipe,
 * WARP) run these kernels slower than the WebAssembly CPU path, so `auto` does not pick them.
 */
export async function requestHardwareAdapter(gpu = globalThis.navigator?.gpu) {
  if (!gpu) return null;
  globalThis.sdcStage = "requestHardwareAdapter";
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  globalThis.sdcStage = "requestHardwareAdapter done";
  if (!adapter) return null;
  const info = adapter.info ?? {};
  if (isSoftwareAdapter({
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: adapter.isFallbackAdapter || info.isFallbackAdapter,
  })) return null;
  return adapter;
}


/** True when this JavaScript engine can suspend WebAssembly on a promise (JSPI). */
export function hasJspi() {
  return typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
}

/** Requests a device with the adapter's storage limits, which large volumes need. */
export async function requestSdcDevice(adapter) {
  const limits = {};
  for (const name of ["maxStorageBufferBindingSize", "maxBufferSize", "maxStorageBuffersPerShaderStage"]) {
    if (adapter.limits?.[name]) limits[name] = adapter.limits[name];
  }
  return adapter.requestDevice({ requiredLimits: limits });
}

/**
 * Compiles the kernels on `device` and returns a factory for the `sdc_gpu` imports of one run.
 * `memory()` must return the instance's WebAssembly.Memory once the instance exists.
 */
export async function createGpuSolver(device) {
  globalThis.sdcStage = "createGpuSolver";
  const pipelines = {};
  await Promise.all(
    Object.entries(SHADERS).map(async ([name, code]) => {
      const module = device.createShaderModule({ code, label: `sdc ${name}` });
      const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
      if (errors.length) throw new Error(`WebGPU kernel ${name} did not compile: ${errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join("; ")}`);
      pipelines[name] = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" }, label: `sdc ${name}` });
    }),
  );
  return { imports: (memory) => runImports(device, pipelines, memory) };
}

function runImports(device, pipelines, memory) {
  let state = null;
  const f64 = (pointer, length) => new Float64Array(memory().buffer, pointer, length);

  function setup(i1, i2, m0, m1, m2, h0, h1, h2, centres, alpha, beta) {
    dispose();
    const cells = m0 * m1 * m2;
    const nodes = m0 * m1 * (m2 + 1);
    const groupsFor = (count) => {
      const groups = Math.ceil(count / WORKGROUP);
      const x = Math.min(groups, MAX_GROUPS_X);
      return [x, Math.ceil(groups / x)];
    };
    const nodeGroups = groupsFor(nodes);
    const cellGroups = groupsFor(cells);
    const groups = nodeGroups[0] * nodeGroups[1];
    const hd = h0 * h1 * h2;
    const w = [1 / (h0 * h0), 1 / (h1 * h1), 1 / (h2 * h2)];
    const wc = 2 * (w[0] + w[1] + w[2]);
    const diff = [-1 / h2, 1 / h2];
    const params = new ArrayBuffer(112);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    u32.set([m0, m1, m2, 0, cells, nodes, groups, 0]);
    f32.set([h2, hd, hd * alpha, hd * beta, w[0], w[1], w[2], wc, diff[0], diff[1], 0, 0, hd * alpha * wc, 0.5 * diff[0], 0.5 * diff[1], diff[0] * diff[0], diff[1] * diff[1], 0, 0, 0], 8);
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buffer = (floats, label) => device.createBuffer({ size: Math.max(4, floats * 4), usage: storage, label: `sdc ${label}` });
    const b = {
      params: device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: "sdc params" }),
      field: buffer(nodes, "field"),
      images: buffer(2 * cells, "images"),
      centres: buffer(m2, "centres"),
      corr: buffer(2 * cells, "corrected"),
      lin: buffer(6 * cells, "linearization"),
      grad: buffer(nodes, "gradient"),
      diag: buffer(nodes, "diagonal"),
      uv: buffer(2 * cells, "hessian terms"),
      x: buffer(nodes, "cg x"),
      r: buffer(nodes, "cg r"),
      z: buffer(nodes, "cg z"),
      p: buffer(nodes, "cg p"),
      hp: buffer(nodes, "cg Hp"),
      partials: buffer(SLOTS * groups, "partials"),
    };
    const readSize = (SLOTS * groups + 2 * cells + nodes) * 4;
    b.read = device.createBuffer({ size: readSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: "sdc readback" });
    const images = new Float32Array(2 * cells);
    images.set(f64(i1, cells));
    images.set(f64(i2, cells), cells);
    device.queue.writeBuffer(b.images, 0, images);
    device.queue.writeBuffer(b.centres, 0, new Float32Array(f64(centres, m2)));
    const bind = (name, ...resources) =>
      device.createBindGroup({
        layout: pipelines[name].getBindGroupLayout(0),
        entries: [b.params, ...resources].map((resource, binding) => ({ binding, resource: { buffer: resource } })),
      });
    const groupsOf = { evalCells: cellGroups, evalNodes: nodeGroups, hessCells: cellGroups, hessNodes: nodeGroups, cgUpdate: nodeGroups, cgDirection: nodeGroups };
    const bindings = {
      evalCells: bind("evalCells", b.field, b.images, b.centres, b.corr, b.lin, b.partials),
      evalNodes: bind("evalNodes", b.field, b.lin, b.grad, b.diag, b.partials),
      hessCells: bind("hessCells", b.p, b.lin, b.uv),
      hessNodes: bind("hessNodes", b.uv, b.p, b.hp, b.partials),
      cgUpdate: bind("cgUpdate", b.x, b.r, b.z, b.p, b.hp, b.diag, b.partials),
      cgDirection: bind("cgDirection", b.z, b.p),
    };
    state = { cells, nodes, groups, cellGroupCount: cellGroups[0] * cellGroups[1], nodeGroupCount: groups, hd, alpha, beta, params, u32, f32, buffers: b, bindings, groupsOf };
  }

  function writeParams({ linearize = 0, step = 0, cgBeta = 0 } = {}) {
    state.u32[3] = linearize;
    state.f32[18] = step;
    state.f32[19] = cgBeta;
    device.queue.writeBuffer(state.buffers.params, 0, state.params);
  }

  function encode(encoder, names) {
    const pass = encoder.beginComputePass();
    for (const name of names) {
      pass.setPipeline(pipelines[name]);
      pass.setBindGroup(0, state.bindings[name]);
      pass.dispatchWorkgroups(...state.groupsOf[name]);
    }
    pass.end();
  }

  // Runs `names` and returns the float64 sums of `slots` (each over `counts[i]` groups) and,
  // when asked, a copy of `extra` ({ buffer, floats }).
  let runCount = 0;
  async function run(names, slots, counts, extra) {
    globalThis.sdcStage = `run ${++runCount} ${names.join(",")} submit`;
    const { buffers, groups } = state;
    const encoder = device.createCommandEncoder();
    encode(encoder, names);
    let offset = 0;
    const offsets = [];
    for (const slot of slots) {
      encoder.copyBufferToBuffer(buffers.partials, slot * groups * 4, buffers.read, offset, groups * 4);
      offsets.push(offset);
      offset += groups * 4;
    }
    const extraOffset = offset;
    if (extra) encoder.copyBufferToBuffer(extra.buffer, 0, buffers.read, extraOffset, extra.floats * 4);
    device.queue.submit([encoder.finish()]);
    const bytes = extraOffset + (extra ? extra.floats * 4 : 0);
    if (bytes === 0) return { sums: [] };
    globalThis.sdcStage = `run ${runCount} mapAsync`;
    await buffers.read.mapAsync(GPUMapMode.READ, 0, bytes);
    globalThis.sdcStage = `run ${runCount} mapped`;
    try {
      const mapped = buffers.read.getMappedRange(0, bytes);
      const sums = slots.map((_, i) => {
        const row = new Float32Array(mapped, offsets[i], counts[i]);
        let s = 0;
        for (let g = 0; g < row.length; g++) s += row[g];
        return s;
      });
      const copy = extra ? new Float32Array(mapped, extraOffset, extra.floats).slice() : null;
      return { sums, copy };
    } finally {
      buffers.read.unmap();
    }
  }

  async function evalAt(bPointer, linearize, gradPointer) {
    const { nodes, buffers, hd, alpha, beta } = state;
    device.queue.writeBuffer(buffers.field, 0, new Float32Array(f64(bPointer, nodes)));
    writeParams({ linearize });
    const { sums, copy } = await run(
      ["evalCells", "evalNodes"],
      [SLOT.residual, SLOT.barrier, SLOT.smooth],
      [state.cellGroupCount, state.cellGroupCount, state.nodeGroupCount],
      linearize ? { buffer: buffers.grad, floats: nodes } : null,
    );
    const [residual, barrier, smooth] = sums;
    if (linearize) f64(gradPointer, nodes).set(copy);
    // Problem::eval: jc = dc + hd α sc + hd β pc.
    const dc = 0.5 * hd * residual;
    const sc = 0.5 * smooth;
    return dc + hd * alpha * sc + hd * beta * barrier;
  }

  async function pcg(rhsPointer, outPointer) {
    const { nodes, buffers } = state;
    const rhs = f64(rhsPointer, nodes);
    let res0 = 0;
    for (let k = 0; k < nodes; k++) res0 += rhs[k] * rhs[k];
    res0 = Math.sqrt(res0);
    device.queue.writeBuffer(buffers.r, 0, new Float32Array(rhs));
    const clear = device.createCommandEncoder();
    for (const name of ["x", "p", "hp"]) clear.clearBuffer(buffers[name]);
    device.queue.submit([clear.finish()]);
    const count = state.nodeGroupCount;
    // z = r / M and p = z, then H p.
    writeParams({ step: 0, cgBeta: 0 });
    let { sums } = await run(["cgUpdate", "cgDirection", "hessCells", "hessNodes"], [SLOT.zr, SLOT.curvature], [count, count]);
    let [gamma, curvature] = sums;
    for (let iteration = 0; iteration < 10; iteration++) {
      const alpha = gamma / curvature;
      if (alpha === Infinity || Number.isNaN(alpha) || alpha < 0) break;
      writeParams({ step: alpha });
      ({ sums } = await run(["cgUpdate"], [SLOT.residualNorm, SLOT.zr], [count, count]));
      const [residualNorm, zr] = sums;
      if (Math.sqrt(residualNorm) / res0 < 0.1 || iteration === 9) break;
      writeParams({ cgBeta: zr / gamma });
      ({ sums } = await run(["cgDirection", "hessCells", "hessNodes"], [SLOT.curvature], [count]));
      [curvature] = sums;
      gamma = zr;
    }
    const { copy } = await run([], [], [], { buffer: buffers.x, floats: nodes });
    f64(outPointer, nodes).set(copy);
  }

  async function corrected(c1, c2) {
    const { cells, buffers } = state;
    const { copy } = await run([], [], [], { buffer: buffers.corr, floats: 2 * cells });
    f64(c1, cells).set(copy.subarray(0, cells));
    f64(c2, cells).set(copy.subarray(cells));
  }

  function dispose() {
    if (!state) return;
    for (const buffer of Object.values(state.buffers)) buffer.destroy();
    state = null;
  }

  return {
    imports: {
      setup,
      eval: new WebAssembly.Suspending(evalAt),
      pcg: new WebAssembly.Suspending(pcg),
      corrected: new WebAssembly.Suspending(corrected),
    },
    dispose,
  };
}
