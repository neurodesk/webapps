// boot.wgsl — Bootstrap streamline generation kernels.
// Mirrors cuslines/metal_shaders/boot.metal.
//
// Compiled as a SEPARATE shader module from generate_streamlines.wgsl.
// Concatenated AFTER: globals.wgsl, types.wgsl, philox_rng.wgsl,
// utils.wgsl, warp_sort.wgsl, tracking_helpers.wgsl.
//
// Key WGSL adaptations vs Metal:
//   - PhiloxState is pass-by-value; every function returns modified state
//   - No ptr<storage> function params; use module-scope buffer access
//     with read_matrix() dispatch for H/R/delta_b/delta_q/sampling_matrix
//   - Workgroup arrays at module scope with compile-time constant sizes
//   - subgroupShuffleXor / subgroupShuffleDown / subgroupBallot
//   - one subgroup per workgroup, so upstream's subgroupBarrier is workgroupBarrier
//   - float3 stored as 3 contiguous f32 in flat storage buffers

// ── parameter struct ────────────────────────────────────────────────
struct BootTrackingParams {
    max_angle: f32,
    tc_threshold: f32,
    step_size: f32,
    relative_peak_thresh: f32,
    min_separation_angle: f32,
    min_signal: f32,
    rng_seed_lo: i32,
    rng_seed_hi: i32,
    rng_offset: i32,
    nseed: i32,
    dimx: i32,
    dimy: i32,
    dimz: i32,
    dimt: i32,
    samplm_nr: i32,
    num_edges: i32,
    delta_nr: i32,
    model_type: i32,
    off_R: i32,
    off_delta_b: i32,
    off_delta_q: i32,
    off_sampling: i32,
    off_b0s: i32,
    workgroup_offset: i32,
    step_budget: i32,
}

// ── buffer bindings ─────────────────────────────────────────────────
// Group 0: common read-only data
@group(0) @binding(0) var<storage, read> params: BootTrackingParams;
@group(0) @binding(1) var<storage, read> seeds: array<f32>;
@group(0) @binding(2) var<storage, read> dataf: array<f32>;       // [DWI signal | sphere_vertices]
@group(0) @binding(3) var<storage, read> metric_map: array<f32>;
@group(0) @binding(4) var<storage, read> sphere_edges: array<i32>;

// Group 1: model matrices and mask
@group(1) @binding(0) var<storage, read> modelData: array<f32>;  // [H | R | delta_b | delta_q | sampling_matrix | b0s_mask]

// Group 2: per-batch / output buffers
@group(2) @binding(0) var<storage, read_write> slineOutOff: array<i32>;
@group(2) @binding(1) var<storage, read_write> shDir0: array<f32>;
@group(2) @binding(2) var<storage, read_write> slineMeta: array<i32>;  // interleaved [seed, len]
@group(2) @binding(3) var<storage, read_write> sline: array<f32>;

// ── buffer-specific vec3 load/store helpers ─────────────────────────
// Same names as generate_streamlines.wgsl so tracking_helpers.wgsl
// functions (trilinear_interp_dataf, check_point_fn, peak_directions_fn,
// load_sphere_verts_f3) can call them.

fn load_seeds_f3(idx: u32) -> vec3<f32> {
    let base = idx * 3u;
    return vec3<f32>(seeds[base], seeds[base + 1u], seeds[base + 2u]);
}

fn load_sphere_verts_f3(idx: u32) -> vec3<f32> {
    let voff = u32(params.dimx) * u32(params.dimy) * u32(params.dimz) * u32(params.dimt);
    let base = voff + idx * 3u;
    return vec3<f32>(dataf[base], dataf[base + 1u], dataf[base + 2u]);
}

fn load_shDir0_f3(idx: u32) -> vec3<f32> {
    let base = idx * 3u;
    return vec3<f32>(shDir0[base], shDir0[base + 1u], shDir0[base + 2u]);
}

fn store_sline_f3(idx: u32, v: vec3<f32>) {
    let base = idx * 3u;
    sline[base] = v.x;
    sline[base + 1u] = v.y;
    sline[base + 2u] = v.z;
}

fn store_shDir0_f3(idx: u32, v: vec3<f32>) {
    let base = idx * 3u;
    shDir0[base] = v.x;
    shDir0[base + 1u] = v.y;
    shDir0[base + 2u] = v.z;
}

fn load_sline_f3(idx: u32) -> vec3<f32> {
    let base = idx * 3u;
    return vec3<f32>(sline[base], sline[base + 1u], sline[base + 2u]);
}

// ── workgroup memory ────────────────────────────────────────────────
// One row per workgroup (BLOCK_Y = 1).
// Boot pool: sh_per_row = 2*MAX_N32DIMT + 2*MAX_N32DIMT = 2048
var<workgroup> wg_sh_mem: array<f32, 2048>;
// For peak_directions atomics: max(n32dimt, samplm_nr) <= MAX_N32DIMT
var<workgroup> wg_sh_ind: array<atomic<i32>, 512>;
// MAX_SLINES_PER_SEED * 3 = 30
var<workgroup> wg_dirs_sh: array<f32, 30>;
// Scratch for closest_peak / new direction
var<workgroup> wg_new_dir: array<f32, 3>;
// Set when the compiled subgroup layout differs from the one the kernel assumes
var<workgroup> wg_lane_mismatch: atomic<u32>;

// Each workgroup is one 32-lane subgroup (one tidy row). Upstream runs two rows
// per workgroup and orders each row's workgroup-memory traffic with
// subgroupBarrier(), which WGSL lacks; with one row, workgroupBarrier() gives
// that ordering on every GPU (#598). The reductions and ballots assume the
// subgroup's lane IDs equal tid.x. WGSL allows other
// sizes (Intel 8/16/32, AMD 64), where the kernel would compute wrong results or
// write outside its row; such a workgroup reports -1 instead (SUBGROUP_LAYOUT_ERROR).
fn subgroupLayoutMismatch(tidx: u32, sg_size: u32, sg_lane: u32) -> bool {
    if (sg_size != THR_X_SL || sg_lane != tidx) {
        atomicStore(&wg_lane_mismatch, 1u);
    }
    workgroupBarrier();
    return workgroup_uniform_i32(i32(atomicLoad(&wg_lane_mismatch)), tidx) != 0;
}

// ── matrix access dispatch ──────────────────────────────────────────
// Replaces device pointer parameters; boot functions specify which
// matrix to read by ID.
const MAT_H: i32 = 0;
const MAT_R: i32 = 1;
const MAT_DELTA_B: i32 = 2;
const MAT_DELTA_Q: i32 = 3;
const MAT_SAMPLING: i32 = 4;

fn read_matrix(mat_id: i32, idx: i32) -> f32 {
    switch mat_id {
        case 0: { return modelData[idx]; }
        case 1: { return modelData[params.off_R + idx]; }
        case 2: { return modelData[params.off_delta_b + idx]; }
        case 3: { return modelData[params.off_delta_q + idx]; }
        case 4: { return modelData[params.off_sampling + idx]; }
        default: { return 0.0; }
    }
}

fn b0s_val(i: i32) -> i32 {
    return i32(modelData[params.off_b0s + i]);
}

// ═══════════════════════════════════════════════════════════════════
// BOOT-SPECIFIC HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

// ── avgMask — subgroup-parallel masked average ──────────────────────
// Averages entries in wg_sh_mem[data_offset..] where b0s_mask[i] != 0.
fn avgMask(mskLen: i32, data_offset: u32, tidx: u32) -> f32 {
    var myCnt: i32 = 0;
    var mySum: f32 = 0.0;

    for (var i = i32(tidx); i < mskLen; i += i32(THR_X_SL)) {
        if (b0s_val(i) != 0) {
            myCnt += 1;
            mySum += wg_sh_mem[data_offset + u32(i)];
        }
    }

    // Reduce across subgroup
    mySum += subgroupShuffleXor(mySum, 16u);
    mySum += subgroupShuffleXor(mySum, 8u);
    mySum += subgroupShuffleXor(mySum, 4u);
    mySum += subgroupShuffleXor(mySum, 2u);
    mySum += subgroupShuffleXor(mySum, 1u);

    var cnt_f = f32(myCnt);
    cnt_f += subgroupShuffleXor(cnt_f, 16u);
    cnt_f += subgroupShuffleXor(cnt_f, 8u);
    cnt_f += subgroupShuffleXor(cnt_f, 4u);
    cnt_f += subgroupShuffleXor(cnt_f, 2u);
    cnt_f += subgroupShuffleXor(cnt_f, 1u);

    return mySum / cnt_f;
}

// ── maskGet — compact non-masked entries ────────────────────────────
// Copies entries from wg_sh_mem[plain_offset..] where b0s_mask==0
// into wg_sh_mem[masked_offset..] in compacted order.
// Returns the number of compacted entries (hr_side).
fn maskGet(n: i32, plain_offset: u32, masked_offset: u32, tidx: u32) -> i32 {
    let laneMask = (1u << tidx) - 1u;

    var woff: i32 = 0;
    for (var j = 0; j < n; j += i32(THR_X_SL)) {
        var act: i32 = 0;
        if (j + i32(tidx) < n) {
            act = select(0, 1, b0s_val(j + i32(tidx)) == 0);
        }

        let ballot = subgroupBallot(act != 0);
        let msk = ballot.x;

        let toff = i32(countOneBits(msk & laneMask));
        if (act != 0) {
            wg_sh_mem[masked_offset + u32(woff + toff)] =
                wg_sh_mem[plain_offset + u32(j) + tidx];
        }
        woff += i32(countOneBits(msk));
    }
    return woff;
}

// ── maskPut — scatter masked entries back ───────────────────────────
// Inverse of maskGet: scatters wg_sh_mem[masked_offset..] back into
// wg_sh_mem[plain_offset..] at positions where b0s_mask==0.
fn maskPut(n: i32, masked_offset: u32, plain_offset: u32, tidx: u32) {
    let laneMask = (1u << tidx) - 1u;

    var woff: i32 = 0;
    for (var j = 0; j < n; j += i32(THR_X_SL)) {
        var act: i32 = 0;
        if (j + i32(tidx) < n) {
            act = select(0, 1, b0s_val(j + i32(tidx)) == 0);
        }

        let ballot = subgroupBallot(act != 0);
        let msk = ballot.x;

        let toff = i32(countOneBits(msk & laneMask));
        if (act != 0) {
            wg_sh_mem[plain_offset + u32(j) + tidx] =
                wg_sh_mem[masked_offset + u32(woff + toff)];
        }
        woff += i32(countOneBits(msk));
    }
}

// ── closest_peak_d — find closest peak to current direction ─────────
// Reads peaks from wg_dirs_sh[dirs_offset..] (as flat f32 triplets).
// Writes result to wg_new_dir[peak_offset..peak_offset+3].
// Returns 1 if a peak within max_angle was found, 0 otherwise.
fn closest_peak_d(
    max_angle: f32, direction: vec3<f32>,
    npeaks: i32, dirs_offset: u32, peak_offset: u32,
    tidx: u32
) -> i32 {
    let cos_similarity = cos(max_angle);

    var cpeak_dot: f32 = 0.0;
    var cpeak_idx: i32 = -1;

    for (var j = 0; j < npeaks; j += i32(THR_X_SL)) {
        if (j + i32(tidx) < npeaks) {
            let base = dirs_offset + u32(j + i32(tidx)) * 3u;
            let px = wg_dirs_sh[base];
            let py = wg_dirs_sh[base + 1u];
            let pz = wg_dirs_sh[base + 2u];

            let dot_val = direction.x * px + direction.y * py + direction.z * pz;

            if (abs(dot_val) > abs(cpeak_dot)) {
                cpeak_dot = dot_val;
                cpeak_idx = j + i32(tidx);
            }
        }
    }

    // Reduce across subgroup to find best peak
    for (var j = i32(THR_X_SL) / 2; j > 0; j /= 2) {
        let other_dot = subgroupShuffleXor(cpeak_dot, u32(j));
        let other_idx = subgroupShuffleXor(cpeak_idx, u32(j));
        if (abs(other_dot) > abs(cpeak_dot)) {
            cpeak_dot = other_dot;
            cpeak_idx = other_idx;
        }
    }

    if (cpeak_idx >= 0) {
        let base = dirs_offset + u32(cpeak_idx) * 3u;
        // Lanes can keep different peaks when two tie, so only lane 0 writes the
        // scratch; the caller takes lane 0's return value (workgroup_uniform_i32).
        if (cpeak_dot >= cos_similarity) {
            if (tidx == 0u) {
                wg_new_dir[peak_offset] = wg_dirs_sh[base];
                wg_new_dir[peak_offset + 1u] = wg_dirs_sh[base + 1u];
                wg_new_dir[peak_offset + 2u] = wg_dirs_sh[base + 2u];
            }
            return 1;
        }
        if (cpeak_dot <= -cos_similarity) {
            if (tidx == 0u) {
                wg_new_dir[peak_offset] = -wg_dirs_sh[base];
                wg_new_dir[peak_offset + 1u] = -wg_dirs_sh[base + 1u];
                wg_new_dir[peak_offset + 2u] = -wg_dirs_sh[base + 2u];
            }
            return 1;
        }
    }
    return 0;
}

// ── ndotp_d — matrix-vector dot product ─────────────────────────────
// dstV[i] = sum_j( srcV[j] * matrix[i*M+j] )  for i in [0..N)
// Source vector in wg_sh_mem[srcV_off..], destination in wg_sh_mem[dstV_off..].
// Matrix accessed via read_matrix(mat_id, ...).
fn ndotp_d(N: i32, M: i32, srcV_off: u32, mat_id: i32, dstV_off: u32, tidx: u32) {
    for (var i = 0; i < N; i++) {
        var tmp: f32 = 0.0;

        for (var j = 0; j < M; j += i32(THR_X_SL)) {
            if (j + i32(tidx) < M) {
                tmp += wg_sh_mem[srcV_off + u32(j) + tidx] *
                       read_matrix(mat_id, i * M + j + i32(tidx));
            }
        }
        // Reduce across subgroup using shuffle down
        tmp += subgroupShuffleDown(tmp, 16u);
        tmp += subgroupShuffleDown(tmp, 8u);
        tmp += subgroupShuffleDown(tmp, 4u);
        tmp += subgroupShuffleDown(tmp, 2u);
        tmp += subgroupShuffleDown(tmp, 1u);

        if (tidx == 0u) {
            wg_sh_mem[dstV_off + u32(i)] = tmp;
        }
    }
}

// ── ndotp_log_opdt_d — OPDT log-weighted dot product ────────────────
// dstV[i] = sum_j( -log(v) * (1.5 + log(v)) * v * matrix[i*M+j] )
fn ndotp_log_opdt_d(N: i32, M: i32, srcV_off: u32, mat_id: i32, dstV_off: u32, tidx: u32) {
    let ONEP5: f32 = 1.5;

    for (var i = 0; i < N; i++) {
        var tmp: f32 = 0.0;

        for (var j = 0; j < M; j += i32(THR_X_SL)) {
            if (j + i32(tidx) < M) {
                let v = wg_sh_mem[srcV_off + u32(j) + tidx];
                let lv = log(v);
                tmp += -lv * (ONEP5 + lv) * v *
                       read_matrix(mat_id, i * M + j + i32(tidx));
            }
        }
        tmp += subgroupShuffleDown(tmp, 16u);
        tmp += subgroupShuffleDown(tmp, 8u);
        tmp += subgroupShuffleDown(tmp, 4u);
        tmp += subgroupShuffleDown(tmp, 2u);
        tmp += subgroupShuffleDown(tmp, 1u);

        if (tidx == 0u) {
            wg_sh_mem[dstV_off + u32(i)] = tmp;
        }
    }
}

// ── ndotp_log_csa_d — CSA log-log-weighted dot product ──────────────
// dstV[i] = sum_j( log(-log(clamp(v))) * matrix[i*M+j] )
fn ndotp_log_csa_d(N: i32, M: i32, srcV_off: u32, mat_id: i32, dstV_off: u32, tidx: u32) {
    let csa_min: f32 = 0.001;
    let csa_max: f32 = 0.999;

    for (var i = 0; i < N; i++) {
        var tmp: f32 = 0.0;

        for (var j = 0; j < M; j += i32(THR_X_SL)) {
            if (j + i32(tidx) < M) {
                let v = clamp(wg_sh_mem[srcV_off + u32(j) + tidx], csa_min, csa_max);
                tmp += log(-log(v)) *
                       read_matrix(mat_id, i * M + j + i32(tidx));
            }
        }
        tmp += subgroupShuffleDown(tmp, 16u);
        tmp += subgroupShuffleDown(tmp, 8u);
        tmp += subgroupShuffleDown(tmp, 4u);
        tmp += subgroupShuffleDown(tmp, 2u);
        tmp += subgroupShuffleDown(tmp, 1u);

        if (tidx == 0u) {
            wg_sh_mem[dstV_off + u32(i)] = tmp;
        }
    }
}

// ── fit_opdt — OPDT model fitting ───────────────────────────────────
// r_sh <- delta_q . msk_data (log-opdt weighted)
// h_sh <- delta_b . msk_data (plain)
// r_sh -= h_sh
fn fit_opdt(delta_nr: i32, hr_side: i32,
            msk_data_off: u32, h_off: u32, r_off: u32, tidx: u32) {
    ndotp_log_opdt_d(delta_nr, hr_side, msk_data_off, MAT_DELTA_Q, r_off, tidx);
    ndotp_d(delta_nr, hr_side, msk_data_off, MAT_DELTA_B, h_off, tidx);
    workgroupBarrier();
    for (var j = i32(tidx); j < delta_nr; j += i32(THR_X_SL)) {
        wg_sh_mem[r_off + u32(j)] -= wg_sh_mem[h_off + u32(j)];
    }
    workgroupBarrier();
}

// ── fit_csa — CSA model fitting ─────────────────────────────────────
// r_sh <- delta_q . msk_data (log-log weighted)
// r_sh[0] = n0_const
fn fit_csa(delta_nr: i32, hr_side: i32,
           msk_data_off: u32, r_off: u32, tidx: u32) {
    let n0_const: f32 = 0.28209479177387814;
    ndotp_log_csa_d(delta_nr, hr_side, msk_data_off, MAT_DELTA_Q, r_off, tidx);
    workgroupBarrier();
    if (tidx == 0u) {
        wg_sh_mem[r_off] = n0_const;
    }
    workgroupBarrier();
}

// ── fit_model_coef — dispatch to OPDT or CSA ────────────────────────
fn fit_model_coef(model_type: i32, delta_nr: i32, hr_side: i32,
                  msk_data_off: u32, h_off: u32, r_off: u32, tidx: u32) {
    switch model_type {
        case 0: /* MODEL_OPDT */ {
            fit_opdt(delta_nr, hr_side, msk_data_off, h_off, r_off, tidx);
        }
        case 1: /* MODEL_CSA */ {
            fit_csa(delta_nr, hr_side, msk_data_off, r_off, tidx);
        }
        default: {}
    }
}

// ═══════════════════════════════════════════════════════════════════
// BOOTSTRAP DIRECTION GETTER
// ═══════════════════════════════════════════════════════════════════

struct GetDirBootResult {
    ndir: i32,
    state: PhiloxState,
}

fn get_direction_boot(
    st: PhiloxState,
    nattempts: i32,
    model_type: i32,
    max_angle: f32,
    min_signal: f32,
    relative_peak_thres: f32,
    min_separation_angle: f32,
    dir: vec3<f32>,
    dimx: i32, dimy: i32, dimz: i32, dimt: i32,
    point: vec3<f32>,
    delta_nr: i32,
    samplm_nr: i32,
    num_edges: i32,
    dirs_offset: u32,   // into wg_dirs_sh (tidy * MAX_SLINES_PER_SEED * 3)
    sh_offset: u32,     // into wg_sh_mem (tidy * sh_per_row = vox_data_off)
    scratch_offset: u32, // into wg_new_dir (tidy * 3)
    ind_offset: u32,    // into wg_sh_ind (tidy * MAX_N32DIMT)
    tidx: u32, tidy: u32
) -> GetDirBootResult {
    var rng = st;

    let n32dimt = u32(((dimt + 31) / 32) * 32);

    // Partition shared memory within the per-tidy row
    let vox_data_off = sh_offset;
    let msk_data_off = vox_data_off + n32dimt;
    let r_off = msk_data_off + n32dimt;
    let h_off = r_off + max(n32dimt, u32(samplm_nr));

    // Compute hr_side (number of non-b0 volumes)
    var hr_side: i32 = 0;
    for (var j = i32(tidx); j < dimt; j += i32(THR_X_SL)) {
        if (b0s_val(j) == 0) {
            hr_side += 1;
        }
    }
    hr_side += subgroupShuffleXor(hr_side, 16u);
    hr_side += subgroupShuffleXor(hr_side, 8u);
    hr_side += subgroupShuffleXor(hr_side, 4u);
    hr_side += subgroupShuffleXor(hr_side, 2u);
    hr_side += subgroupShuffleXor(hr_side, 1u);

    for (var attempt = 0; attempt < nattempts; attempt++) {

        // Trilinear interpolation of dataf at point -> wg_sh_mem[vox_data_off..]
        let rv = workgroup_uniform_i32(
            trilinear_interp_dataf(dimx, dimy, dimz, dimt, point, vox_data_off, tidx), tidx);

        // maskGet: compact non-b0 entries from vox_data -> msk_data
        maskGet(dimt, vox_data_off, msk_data_off, tidx);

        workgroupBarrier();

        if (rv == 0) {
            // Multiply masked data by R and H matrices
            ndotp_d(hr_side, hr_side, msk_data_off, MAT_R, r_off, tidx);
            ndotp_d(hr_side, hr_side, msk_data_off, MAT_H, h_off, tidx);

            workgroupBarrier();

            // Bootstrap: add permuted residuals
            for (var j = 0; j < hr_side; j += i32(THR_X_SL)) {
                if (j + i32(tidx) < hr_side) {
                    let pr = philox_uint(rng);
                    rng = pr.state;
                    let srcPermInd = i32(pr.value % u32(hr_side));
                    wg_sh_mem[h_off + u32(j) + tidx] += wg_sh_mem[r_off + u32(srcPermInd)];
                }
            }
            workgroupBarrier();

            // Scatter back: vox_data[dwi_mask] = masked_data
            maskPut(dimt, h_off, vox_data_off, tidx);
            workgroupBarrier();

            // Clamp to min_signal
            for (var j = i32(tidx); j < dimt; j += i32(THR_X_SL)) {
                wg_sh_mem[vox_data_off + u32(j)] = max(min_signal, wg_sh_mem[vox_data_off + u32(j)]);
            }
            workgroupBarrier();

            // Normalize by b0 average
            let denom = avgMask(dimt, vox_data_off, tidx);

            for (var j = i32(tidx); j < dimt; j += i32(THR_X_SL)) {
                wg_sh_mem[vox_data_off + u32(j)] /= denom;
            }
            workgroupBarrier();

            // Re-compact after normalization
            maskGet(dimt, vox_data_off, msk_data_off, tidx);
            workgroupBarrier();

            // Fit model coefficients
            fit_model_coef(model_type, delta_nr, hr_side,
                           msk_data_off, h_off, r_off, tidx);

            // Compute PMF: sampling_matrix * coef -> h_sh
            // r_off holds the coefficients after fitting
            ndotp_d(samplm_nr, delta_nr, r_off, MAT_SAMPLING, h_off, tidx);

            // h_off now holds PMF
        } else {
            // Outside image: zero PMF
            for (var j = i32(tidx); j < samplm_nr; j += i32(THR_X_SL)) {
                wg_sh_mem[h_off + u32(j)] = 0.0;
            }
        }
        workgroupBarrier();

        // Absolute PMF threshold
        let abs_pmf_thr = PMF_THRESHOLD_P *
            sg_max_reduce_wg(samplm_nr, h_off, REAL_MIN, tidx);
        workgroupBarrier();

        // Zero entries below threshold
        for (var j = i32(tidx); j < samplm_nr; j += i32(THR_X_SL)) {
            if (wg_sh_mem[h_off + u32(j)] < abs_pmf_thr) {
                wg_sh_mem[h_off + u32(j)] = 0.0;
            }
        }
        workgroupBarrier();

        // Find peak directions
        let ndir = peak_directions_fn(
            h_off, dirs_offset, ind_offset,
            num_edges, samplm_nr,
            relative_peak_thres, min_separation_angle,
            tidx);

        if (nattempts == 1) {
            // init=True: return number of initial directions
            return GetDirBootResult(ndir, rng);
        } else {
            // init=False: find closest peak to current direction
            if (ndir > 0) {
                let foundPeak = workgroup_uniform_i32(closest_peak_d(
                    max_angle, dir, ndir, dirs_offset, scratch_offset, tidx), tidx);
                if (foundPeak != 0) {
                    // Copy result from scratch to dirs[0]
                    if (tidx == 0u) {
                        wg_dirs_sh[dirs_offset] = wg_new_dir[scratch_offset];
                        wg_dirs_sh[dirs_offset + 1u] = wg_new_dir[scratch_offset + 1u];
                        wg_dirs_sh[dirs_offset + 2u] = wg_new_dir[scratch_offset + 2u];
                    }
                    return GetDirBootResult(1, rng);
                }
            }
        }
    }
    return GetDirBootResult(0, rng);
}

// ═══════════════════════════════════════════════════════════════════
// KERNEL ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════

// ── getNumStreamlinesBoot_k — count streamlines per seed ────────────
@compute @workgroup_size(32, 1, 1)
fn getNumStreamlinesBoot_k(
    @builtin(local_invocation_id) tid: vec3<u32>,
    @builtin(workgroup_id) gid: vec3<u32>,
    @builtin(subgroup_size) sg_size: u32,
    @builtin(subgroup_invocation_id) sg_lane: u32
) {
    let layout_mismatch = subgroupLayoutMismatch(tid.x, sg_size, sg_lane);
    let tidx = tid.x;
    let tidy = 0u;  // one row (subgroup) per workgroup
    let logical_group = gid.x + u32(params.workgroup_offset);
    let slid = logical_group * BLOCK_Y + tidy;

    if (i32(slid) >= params.nseed) { return; }
    if (layout_mismatch) {
        if (tidx == 0u) { slineOutOff[slid] = -1; }
        return;
    }

    // Philox stream per (seed index in the whole run, lane), whatever the batch size (#598).
    let global_id = (u32(params.rng_offset) + logical_group * BLOCK_Y + tidy) * THR_X_SL + tidx;
    var st = philox_init(
        u32(params.rng_seed_lo), u32(params.rng_seed_hi), global_id, 0u);

    let n32dimt = u32(((params.dimt + 31) / 32) * 32);
    let sh_per_row = 2u * n32dimt + 2u * max(n32dimt, u32(params.samplm_nr));

    let sh_offset = tidy * sh_per_row;
    let dirs_offset = tidy * MAX_SLINES_PER_SEED * 3u;
    let scratch_offset = tidy * 3u;
    let ind_offset = tidy * max(n32dimt, u32(params.samplm_nr));

    let seed = load_seeds_f3(slid);

    var ndir: i32 = 0;
    switch params.model_type {
        case 0, 1: /* MODEL_OPDT, MODEL_CSA */ {
            let gdr = get_direction_boot(
                st,
                1,  // NATTEMPTS=1 (init=True)
                params.model_type,
                params.max_angle,
                params.min_signal,
                params.relative_peak_thresh,
                params.min_separation_angle,
                vec3<f32>(0.0, 0.0, 0.0),
                params.dimx, params.dimy, params.dimz, params.dimt,
                seed,
                params.delta_nr,
                params.samplm_nr,
                params.num_edges,
                dirs_offset, sh_offset, scratch_offset, ind_offset,
                tidx, tidy);
            ndir = gdr.ndir;
        }
        default: {
            ndir = 0;
        }
    }

    // Copy found directions to global output buffer
    for (var j = i32(tidx); j < ndir; j += i32(THR_X_SL)) {
        let src_base = dirs_offset + u32(j) * 3u;
        let dst_idx = (slid * u32(params.samplm_nr) + u32(j)) * 3u;
        shDir0[dst_idx] = wg_dirs_sh[src_base];
        shDir0[dst_idx + 1u] = wg_dirs_sh[src_base + 1u];
        shDir0[dst_idx + 2u] = wg_dirs_sh[src_base + 2u];
    }

    if (tidx == 0u) {
        slineOutOff[slid] = ndir;
    }
}

// ── resumable generation state (#598) ───────────────────────────────
// A seed row tracks up to MAX_SLINES_PER_SEED streamlines of up to 2 * MAX_SLINE_LEN
// steps, too long for one GPU command where the driver resets work that does not
// yield (Intel/Mesa preempts after 640 ms). Each command runs at most
// params.step_budget tracking steps per row and saves where it stopped in
// slineOutOff, after the per-seed offsets [0, nseed]:
//   [nseed + 1 + slid]                      1 while the row has streamlines left
//   [2 * nseed + 1 + slid * ROW_STATE_WORDS] the row's position, then each lane's
//                                            Philox state
// The steps, their order and the random draws are the original kernel's, so the
// output does not depend on the budget.
const ROW_STATE_WORDS: u32 = 16u + THR_X_SL * 13u;
const PHASE_START: i32 = 0;
const PHASE_BACKWARD: i32 = 1;
const PHASE_FORWARD: i32 = 2;

fn pending_index(slid: u32) -> u32 {
    return u32(params.nseed) + 1u + slid;
}

fn row_state_index(slid: u32) -> u32 {
    return 2u * u32(params.nseed) + 1u + slid * ROW_STATE_WORDS;
}

fn load_state_f3(idx: u32) -> vec3<f32> {
    return vec3<f32>(bitcast<f32>(slineOutOff[idx]),
                     bitcast<f32>(slineOutOff[idx + 1u]),
                     bitcast<f32>(slineOutOff[idx + 2u]));
}

fn store_state_f3(idx: u32, v: vec3<f32>) {
    slineOutOff[idx] = bitcast<i32>(v.x);
    slineOutOff[idx + 1u] = bitcast<i32>(v.y);
    slineOutOff[idx + 2u] = bitcast<i32>(v.z);
}

fn load_philox(idx: u32) -> PhiloxState {
    var st: PhiloxState;
    st.counter = vec4<u32>(u32(slineOutOff[idx]), u32(slineOutOff[idx + 1u]),
                           u32(slineOutOff[idx + 2u]), u32(slineOutOff[idx + 3u]));
    st.key = vec2<u32>(u32(slineOutOff[idx + 4u]), u32(slineOutOff[idx + 5u]));
    st.output = vec4<u32>(u32(slineOutOff[idx + 6u]), u32(slineOutOff[idx + 7u]),
                          u32(slineOutOff[idx + 8u]), u32(slineOutOff[idx + 9u]));
    st.idx = u32(slineOutOff[idx + 10u]);
    st.cached_normal = bitcast<f32>(slineOutOff[idx + 11u]);
    st.has_cached = u32(slineOutOff[idx + 12u]);
    return st;
}

fn store_philox(idx: u32, st: PhiloxState) {
    for (var k = 0u; k < 4u; k++) {
        slineOutOff[idx + k] = i32(st.counter[k]);
        slineOutOff[idx + 6u + k] = i32(st.output[k]);
    }
    slineOutOff[idx + 4u] = i32(st.key.x);
    slineOutOff[idx + 5u] = i32(st.key.y);
    slineOutOff[idx + 10u] = i32(st.idx);
    slineOutOff[idx + 11u] = bitcast<i32>(st.cached_normal);
    slineOutOff[idx + 12u] = i32(st.has_cached);
}

// ── genStreamlinesMergeBoot_k — main bootstrap streamline kernel ────
// Each call continues every row of its workgroups from the saved state, for at
// most params.step_budget steps; the host calls it until no row is pending.
@compute @workgroup_size(32, 1, 1)
fn genStreamlinesMergeBoot_k(
    @builtin(local_invocation_id) tid: vec3<u32>,
    @builtin(workgroup_id) gid: vec3<u32>,
    @builtin(subgroup_size) sg_size: u32,
    @builtin(subgroup_invocation_id) sg_lane: u32
) {
    let layout_mismatch = subgroupLayoutMismatch(tid.x, sg_size, sg_lane);
    let tidx = tid.x;
    let tidy = 0u;  // one row (subgroup) per workgroup
    let logical_group = gid.x + u32(params.workgroup_offset);
    let slid = logical_group * BLOCK_Y + tidy;

    if (i32(slid) >= params.nseed) { return; }

    let row = row_state_index(slid);
    let lane_state = row + 16u + tidx * 13u;
    var st: PhiloxState;
    if (slineOutOff[row] == 0) {
        // Philox stream per (seed index in the whole run, lane), whatever the batch size (#598).
        let global_id = (u32(params.rng_offset) + logical_group * BLOCK_Y + tidy) * THR_X_SL + tidx;
        st = philox_init(
            u32(params.rng_seed_lo), u32(params.rng_seed_hi), global_id + 1u, 0u);
    } else {
        st = load_philox(lane_state);
    }

    let seed = load_seeds_f3(slid);

    let ndir = workgroup_uniform_i32(slineOutOff[slid + 1u] - slineOutOff[slid], tidx);
    if (layout_mismatch) {
        if (tidx == 0u) {
            for (var i = 0; i < ndir; i++) {
                slineMeta[2 * (slineOutOff[slid] + i) + 1] = -1;
            }
            slineOutOff[pending_index(slid)] = 0;
        }
        return;
    }

    workgroupBarrier();

    let n32dimt = u32(((params.dimt + 31) / 32) * 32);
    let sh_per_row = 2u * n32dimt + 2u * max(n32dimt, u32(params.samplm_nr));

    let sh_offset = tidy * sh_per_row;
    let dirs_offset = tidy * MAX_SLINES_PER_SEED * 3u;
    let scratch_offset = tidy * 3u;
    let ind_offset = tidy * max(n32dimt, u32(params.samplm_nr));

    var dir_i = workgroup_uniform_i32(slineOutOff[row + 1u], tidx);
    var phase = workgroup_uniform_i32(slineOutOff[row + 2u], tidx);
    var step = workgroup_uniform_i32(slineOutOff[row + 3u], tidx);
    var stepsB = workgroup_uniform_i32(slineOutOff[row + 4u], tidx);
    var point = load_state_f3(row + 5u);
    var direction = load_state_f3(row + 8u);
    var budget = params.step_budget;

    loop {
        if (dir_i >= ndir) { break; }
        let sline_off = slineOutOff[slid] + dir_i;
        let dir_idx = slid * u32(params.samplm_nr) + u32(dir_i);
        let first_step = load_shDir0_f3(dir_idx);

        // Flat f32 base for this streamline's sline storage
        let sline_base_f3 = u32(sline_off) * u32(MAX_SLINE_LEN) * 2u;

        if (phase == PHASE_START) {
            if (tidx == 0u) {
                slineMeta[2 * sline_off] = i32(slid);
            }
            // ── Track backward ── starts at the seed
            point = seed;
            direction = vec3<f32>(-first_step.x, -first_step.y, -first_step.z);
            if (tidx == 0u) {
                store_sline_f3(sline_base_f3, point);
            }
            workgroupBarrier();
            phase = PHASE_BACKWARD;
            step = 1;
        }

        // One tracking step; `ended` stops this direction as upstream's tracker_boot loop did.
        var ended = step >= MAX_SLINE_LEN;
        if (!ended) {
            if (budget <= 0) { break; }
            budget -= 1;
            let base = select(sline_base_f3 + u32(stepsB - 1), sline_base_f3, phase == PHASE_BACKWARD);
            let gdr = get_direction_boot(
                st,
                5,  // NATTEMPTS
                params.model_type,
                params.max_angle,
                params.min_signal,
                params.relative_peak_thresh,
                params.min_separation_angle,
                direction,
                params.dimx, params.dimy, params.dimz, params.dimt,
                point,
                params.delta_nr, params.samplm_nr, params.num_edges,
                dirs_offset, sh_offset, scratch_offset, ind_offset,
                tidx, tidy);
            st = gdr.state;
            workgroupBarrier();

            // Read direction from scratch (closest_peak wrote it there)
            direction = vec3<f32>(
                wg_new_dir[scratch_offset],
                wg_new_dir[scratch_offset + 1u],
                wg_new_dir[scratch_offset + 2u]);
            workgroupBarrier();

            // The rng state is per lane; the direction count is the same in every lane.
            if (workgroup_uniform_i32(gdr.ndir, tidx) == 0) {
                ended = true;
            } else {
                // Advance point (voxel_size is 1.0 for boot)
                point.x += direction.x * params.step_size;
                point.y += direction.y * params.step_size;
                point.z += direction.z * params.step_size;

                if (tidx == 0u) {
                    store_sline_f3(base + u32(step), point);
                }
                workgroupBarrier();

                let tissue_class = workgroup_uniform_i32(check_point_fn(
                    params.tc_threshold, point, params.dimx, params.dimy, params.dimz, tidx, tidy), tidx);

                if (tissue_class == ENDPOINT ||
                    tissue_class == INVALIDPOINT ||
                    tissue_class == OUTSIDEIMAGE) {
                    ended = true;
                } else {
                    step += 1;
                }
            }
        }

        if (ended) {
            if (phase == PHASE_BACKWARD) {
                stepsB = step;

                // ── Reverse backward streamline ──
                for (var j = i32(tidx); j < stepsB / 2; j += i32(THR_X_SL)) {
                    let a_idx = sline_base_f3 + u32(j);
                    let b_idx = sline_base_f3 + u32(stepsB - 1 - j);
                    let pa = load_sline_f3(a_idx);
                    let pb = load_sline_f3(b_idx);
                    store_sline_f3(a_idx, pb);
                    store_sline_f3(b_idx, pa);
                }

                // ── Track forward ── starts at the seed
                point = seed;
                direction = first_step;
                if (tidx == 0u) {
                    store_sline_f3(sline_base_f3 + u32(stepsB - 1), point);
                }
                workgroupBarrier();
                phase = PHASE_FORWARD;
                step = 1;
            } else {
                if (tidx == 0u) {
                    slineMeta[2 * sline_off + 1] = stepsB - 1 + step;
                }
                dir_i += 1;
                phase = PHASE_START;
            }
        }
    }

    store_philox(lane_state, st);
    if (tidx == 0u) {
        slineOutOff[row] = 1;
        slineOutOff[row + 1u] = dir_i;
        slineOutOff[row + 2u] = phase;
        slineOutOff[row + 3u] = step;
        slineOutOff[row + 4u] = stepsB;
        store_state_f3(row + 5u, point);
        store_state_f3(row + 8u, direction);
        slineOutOff[pending_index(slid)] = select(0, 1, dir_i < ndir);
    }
}
