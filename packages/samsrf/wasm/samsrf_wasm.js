/* @ts-self-types="./samsrf_wasm.d.ts" */

/**
 * Stimulus apertures in wasm memory, sparse per frame.
 */
export class Apertures {
    static __wrap(ptr) {
        const obj = Object.create(Apertures.prototype);
        obj.__wbg_ptr = ptr;
        AperturesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AperturesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_apertures_free(ptr, 0);
    }
    /**
     * @param {Uint8Array | number[]} bytes
     * @returns {Apertures}
     */
    static deserialize(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.apertures_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Apertures.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.apertures_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} scaling_factor
     * @returns {Float64Array}
     */
    scaledXy(scaling_factor) {
        const ret = wasm.apertures_scaledXy(this.__wbg_ptr, scaling_factor);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.apertures_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    toDense() {
        const ret = wasm.apertures_toDense(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    get volumes() {
        const ret = wasm.apertures_volumes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.apertures_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Apertures.prototype[Symbol.dispose] = Apertures.prototype.free;

/**
 * One prepared analysis; see packages/samsrf/README.md for `createJob`.
 */
export class Job {
    static __wrap(ptr) {
        const obj = Object.create(Job.prototype);
        obj.__wbg_ptr = ptr;
        JobFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JobFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_job_free(ptr, 0);
    }
    /**
     * The analysed vertices in label order.
     * @returns {Uint32Array}
     */
    analysed() {
        const ret = wasm.job_analysed(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {Array<any>} partials
     * @returns {any}
     */
    merge(partials) {
        const ret = wasm.job_merge(this.__wbg_ptr, partials);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {string}
     */
    get modelName() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.job_modelName(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get outSuffix() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.job_outSuffix(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} start
     * @param {number} end
     * @param {Function | null} [progress]
     * @returns {Uint8Array}
     */
    run(start, end, progress) {
        const val1 = +start;
        const val2 = +end;
        const ret = wasm.job_run(this.__wbg_ptr, val1, val2, isLikeNone(progress) ? 0 : addToExternrefTable0(progress));
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * @returns {Array<any>}
     */
    values() {
        const ret = wasm.job_values(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get vertexCount() {
        const ret = wasm.job_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Job.prototype[Symbol.dispose] = Job.prototype.free;

/**
 * A functional run in wasm memory: float32, vertex-major.
 */
export class Run {
    static __wrap(ptr) {
        const obj = Object.create(Run.prototype);
        obj.__wbg_ptr = ptr;
        RunFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RunFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_run_free(ptr, 0);
    }
    /**
     * @param {number} vertex
     * @returns {Float32Array}
     */
    course(vertex) {
        const ret = wasm.run_course(this.__wbg_ptr, vertex);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    get vertices() {
        const ret = wasm.run_vertices(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get volumes() {
        const ret = wasm.run_volumes(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Run.prototype[Symbol.dispose] = Run.prototype.free;

/**
 * Streams runs into the combined, normalised time courses of the kept vertices.
 */
export class RunAccumulator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RunAccumulatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_runaccumulator_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    finish() {
        const ret = wasm.runaccumulator_finish(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} total_vertices
     * @param {Uint32Array | number[] | null | undefined} keep
     * @param {string} normalise
     * @param {string} combine
     * @param {boolean} noise_ceiling
     * @param {boolean} global_signal
     */
    constructor(total_vertices, keep, normalise, combine, noise_ceiling, global_signal) {
        const val4 = +total_vertices;
        const val5 = +noise_ceiling;
        const val6 = +global_signal;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = isLikeNone(keep) ? 0 : passArray32ToWasm0(keep, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(normalise, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(combine, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        const ret = wasm.runaccumulator_new(val4, ptr0, len0, ptr1, len1, ptr2, len2, val5, val6);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        RunAccumulatorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Run} run
     */
    pushRun(run) {
        _assertClass(run, Run);
        const ret = wasm.runaccumulator_pushRun(this.__wbg_ptr, run.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) RunAccumulator.prototype[Symbol.dispose] = RunAccumulator.prototype.free;

/**
 * @param {string} kind
 * @param {string} model_json
 * @param {Uint8Array | number[] | null | undefined} apertures
 * @param {string} hrf_mode
 * @param {Float64Array | number[] | null | undefined} hrf_kernel
 * @param {number} volumes
 * @param {Uint32Array | number[]} kept
 * @param {Float64Array | number[]} courses
 * @param {Uint32Array | number[] | null | undefined} roi
 * @param {Float64Array | number[] | null | undefined} noise_ceiling
 * @param {Float64Array | number[] | null | undefined} global_signal
 * @param {Uint32Array | number[] | null | undefined} seed_vertices
 * @param {string[] | null | undefined} template_values
 * @param {Float64Array | number[] | null | undefined} template_data
 * @param {Float64Array | number[] | null | undefined} surface_vertices
 * @param {Uint32Array | number[] | null | undefined} surface_faces
 * @param {Float64Array | number[] | null | undefined} area
 * @param {string[] | null | undefined} seed_fine_fit_values
 * @param {Float64Array | number[] | null | undefined} seed_fine_fit_data
 * @param {number} total_vertices
 * @param {Function | null} [progress]
 * @returns {Job}
 */
export function createJob(kind, model_json, apertures, hrf_mode, hrf_kernel, volumes, kept, courses, roi, noise_ceiling, global_signal, seed_vertices, template_values, template_data, surface_vertices, surface_faces, area, seed_fine_fit_values, seed_fine_fit_data, total_vertices, progress) {
    const val19 = +volumes;
    const val20 = +total_vertices;
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, ptr13, len13, ptr14, len14, ptr15, len15, ptr16, len16, ptr17, len17;
    try {
        ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = isLikeNone(apertures) ? 0 : passArray8ToWasm0(apertures, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
        ptr3 = passStringToWasm0(hrf_mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len3 = WASM_VECTOR_LEN;
        ptr4 = isLikeNone(hrf_kernel) ? 0 : passArrayF64ToWasm0(hrf_kernel, wasm.__wbindgen_malloc);
        len4 = WASM_VECTOR_LEN;
        ptr5 = passArray32ToWasm0(kept, wasm.__wbindgen_malloc);
        len5 = WASM_VECTOR_LEN;
        ptr6 = passArrayF64ToWasm0(courses, wasm.__wbindgen_malloc);
        len6 = WASM_VECTOR_LEN;
        ptr7 = isLikeNone(roi) ? 0 : passArray32ToWasm0(roi, wasm.__wbindgen_malloc);
        len7 = WASM_VECTOR_LEN;
        ptr8 = isLikeNone(noise_ceiling) ? 0 : passArrayF64ToWasm0(noise_ceiling, wasm.__wbindgen_malloc);
        len8 = WASM_VECTOR_LEN;
        ptr9 = isLikeNone(global_signal) ? 0 : passArrayF64ToWasm0(global_signal, wasm.__wbindgen_malloc);
        len9 = WASM_VECTOR_LEN;
        ptr10 = isLikeNone(seed_vertices) ? 0 : passArray32ToWasm0(seed_vertices, wasm.__wbindgen_malloc);
        len10 = WASM_VECTOR_LEN;
        ptr11 = isLikeNone(template_values) ? 0 : passArrayJsValueToWasm0(template_values, wasm.__wbindgen_malloc);
        len11 = WASM_VECTOR_LEN;
        ptr12 = isLikeNone(template_data) ? 0 : passArrayF64ToWasm0(template_data, wasm.__wbindgen_malloc);
        len12 = WASM_VECTOR_LEN;
        ptr13 = isLikeNone(surface_vertices) ? 0 : passArrayF64ToWasm0(surface_vertices, wasm.__wbindgen_malloc);
        len13 = WASM_VECTOR_LEN;
        ptr14 = isLikeNone(surface_faces) ? 0 : passArray32ToWasm0(surface_faces, wasm.__wbindgen_malloc);
        len14 = WASM_VECTOR_LEN;
        ptr15 = isLikeNone(area) ? 0 : passArrayF64ToWasm0(area, wasm.__wbindgen_malloc);
        len15 = WASM_VECTOR_LEN;
        ptr16 = isLikeNone(seed_fine_fit_values) ? 0 : passArrayJsValueToWasm0(seed_fine_fit_values, wasm.__wbindgen_malloc);
        len16 = WASM_VECTOR_LEN;
        ptr17 = isLikeNone(seed_fine_fit_data) ? 0 : passArrayF64ToWasm0(seed_fine_fit_data, wasm.__wbindgen_malloc);
        len17 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr17) { wasm.__wbindgen_free(ptr17, len17 * 8, 8); }
        if (ptr16) { wasm.__externref_drop_slice(ptr16, len16); wasm.__wbindgen_free(ptr16, len16 * 4, 4); }
        if (ptr15) { wasm.__wbindgen_free(ptr15, len15 * 8, 8); }
        if (ptr14) { wasm.__wbindgen_free(ptr14, len14 * 4, 4); }
        if (ptr13) { wasm.__wbindgen_free(ptr13, len13 * 8, 8); }
        if (ptr12) { wasm.__wbindgen_free(ptr12, len12 * 8, 8); }
        if (ptr11) { wasm.__externref_drop_slice(ptr11, len11); wasm.__wbindgen_free(ptr11, len11 * 4, 4); }
        if (ptr10) { wasm.__wbindgen_free(ptr10, len10 * 4, 4); }
        if (ptr9) { wasm.__wbindgen_free(ptr9, len9 * 8, 8); }
        if (ptr8) { wasm.__wbindgen_free(ptr8, len8 * 8, 8); }
        if (ptr7) { wasm.__wbindgen_free(ptr7, len7 * 4, 4); }
        if (ptr6) { wasm.__wbindgen_free(ptr6, len6 * 8, 8); }
        if (ptr5) { wasm.__wbindgen_free(ptr5, len5 * 4, 4); }
        if (ptr4) { wasm.__wbindgen_free(ptr4, len4 * 8, 8); }
        if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.createJob(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, val19, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, ptr13, len13, ptr14, len14, ptr15, len15, ptr16, len16, ptr17, len17, val20, isLikeNone(progress) ? 0 : addToExternrefTable0(progress));
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Job.__wrap(ret[0]);
}

/**
 * @param {Float64Array | number[]} x
 * @returns {Float64Array}
 */
export function detrend(x) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detrend(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * `kernel` is the HRF; without one, `fit_tr` is the TR of the fitted HRF.
 * @param {string} source
 * @param {Apertures} apertures
 * @param {Float64Array | number[]} xy
 * @param {Float64Array | number[] | null | undefined} kernel
 * @param {number | null | undefined} fit_tr
 * @param {Float64Array | number[]} params
 * @param {Float64Array | number[]} observed
 * @param {number} downsampling
 * @param {boolean} css_nonlinearity
 * @returns {number}
 */
export function errfun(source, apertures, xy, kernel, fit_tr, params, observed, downsampling, css_nonlinearity) {
    _assertClass(apertures, Apertures);
    const val6 = +(isLikeNone(fit_tr) ? 0 : fit_tr);
    const val7 = +downsampling;
    const val8 = +css_nonlinearity;
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4;
    try {
        ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(xy, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = isLikeNone(kernel) ? 0 : passArrayF64ToWasm0(kernel, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
        ptr3 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
        len3 = WASM_VECTOR_LEN;
        ptr4 = passArrayF64ToWasm0(observed, wasm.__wbindgen_malloc);
        len4 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr4) { wasm.__wbindgen_free(ptr4, len4 * 8, 8); }
        if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 8, 8); }
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 8, 8); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.errfun(ptr0, len0, apertures.__wbg_ptr, ptr1, len1, ptr2, len2, !isLikeNone(fit_tr), val6, ptr3, len3, ptr4, len4, val7, val8);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * `args` arrive flattened: the shape of argument `i` is `rows[i] x cols[i]` and its
 * column-major values follow the previous argument's in `data`.
 * @param {string} source
 * @param {Uint32Array | number[]} rows
 * @param {Uint32Array | number[]} cols
 * @param {Float64Array | number[]} data
 * @returns {any}
 */
export function evaluateExpression(source, rows, cols, data) {
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
    try {
        ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray32ToWasm0(rows, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArray32ToWasm0(cols, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
        ptr3 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        len3 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 8, 8); }
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.evaluateExpression(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string[]} values
 * @param {number} vertices
 * @param {Float64Array | number[]} data
 * @param {string} prefix
 * @param {string[] | null} [selection]
 * @returns {Array<any>}
 */
export function exportGiis(values, vertices, data, prefix, selection) {
    const val5 = +vertices;
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
    try {
        ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len2 = WASM_VECTOR_LEN;
        ptr3 = isLikeNone(selection) ? 0 : passArrayJsValueToWasm0(selection, wasm.__wbindgen_malloc);
        len3 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr3) { wasm.__externref_drop_slice(ptr3, len3); wasm.__wbindgen_free(ptr3, len3 * 4, 4); }
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__externref_drop_slice(ptr0, len0); wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
        throw e;
    }
    const ret = wasm.exportGiis(ptr0, len0, val5, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Float64Array | number[]} y
 * @param {Float64Array | number[]} kernel
 * @param {number} downsampling
 * @returns {Float64Array}
 */
export function hrfConvolve(y, kernel, downsampling) {
    const val3 = +downsampling;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(kernel, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.hrfConvolve(ptr0, len0, ptr1, len1, val3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * @param {number} tr
 * @returns {Float64Array}
 */
export function hrfDeHaas(tr) {
    const ret = wasm.hrfDeHaas(tr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} tr
 * @param {Float64Array | number[]} p
 * @returns {Float64Array}
 */
export function hrfDoublegamma(tr, p) {
    const val2 = +tr;
    const ptr0 = passArrayF64ToWasm0(p, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hrfDoublegamma(val2, ptr0, len0);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {number} tr
 * @param {Float64Array | number[]} fp
 * @returns {Float64Array}
 */
export function hrfOldSchool(tr, fp) {
    const val2 = +tr;
    const ptr0 = passArrayF64ToWasm0(fp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hrfOldSchool(val2, ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * Resolves a parsed model's `hrf` object (`type` plus `values` or `file`).
 * @param {string} kind
 * @param {Float64Array | number[] | null | undefined} values
 * @param {string | null | undefined} file
 * @param {number} tr
 * @returns {any}
 */
export function hrfResolve(kind, values, file, tr) {
    const val4 = +tr;
    let ptr0, len0, ptr1, len1, ptr2, len2;
    try {
        ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = isLikeNone(values) ? 0 : passArrayF64ToWasm0(values, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = isLikeNone(file) ? 0 : passStringToWasm0(file, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len2 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.hrfResolve(ptr0, len0, ptr1, len1, ptr2, len2, val4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} tr
 * @returns {Float64Array}
 */
export function hrfSpmCanonical(tr) {
    const ret = wasm.hrfSpmCanonical(tr);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {Float64Array | number[]} odd
 * @param {Float64Array | number[]} even
 * @returns {number}
 */
export function noiseCeiling(odd, even) {
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayF64ToWasm0(odd, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(even, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.noiseCeiling(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * The model as JSON. Serde's default form of `HrfSpec` is rewritten to
 * `{ type, values }` / `{ type, file }` here because an internally tagged enum
 * cannot carry the core's tuple variants.
 * @param {string} kind
 * @param {string} json
 * @returns {string}
 */
export function parseModel(kind, json) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.parseModel(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * @param {Float64Array | number[]} x
 * @param {Float64Array | number[]} y
 * @returns {number}
 */
export function pearson(x, y) {
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.pearson(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * @param {string[]} values
 * @param {number} vertices
 * @param {Float64Array | number[]} data
 * @returns {any}
 */
export function polarAndEccentricity(values, vertices, data) {
    const val3 = +vertices;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__externref_drop_slice(ptr0, len0); wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
        throw e;
    }
    const ret = wasm.polarAndEccentricity(ptr0, len0, val3, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Float64Array | number[]} rfp
 * @param {Apertures} apertures
 * @returns {Float64Array}
 */
export function predictTimecourse(rfp, apertures) {
    _assertClass(apertures, Apertures);
    const ptr0 = passArrayF64ToWasm0(rfp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.predictTimecourse(ptr0, len0, apertures.__wbg_ptr);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {string} source
 * @param {Float64Array | number[]} params
 * @param {number} screen_width
 * @returns {Float64Array}
 */
export function prfProfileGrid(source, params, screen_width) {
    const val3 = +screen_width;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.prfProfileGrid(ptr0, len0, ptr1, len1, val3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * @param {string} source
 * @param {Float64Array | number[]} params
 * @param {Float64Array | number[]} xy
 * @returns {Float64Array}
 */
export function prfProfileXy(source, params, xy) {
    let ptr0, len0, ptr1, len1, ptr2, len2;
    try {
        ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArrayF64ToWasm0(xy, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 8, 8); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.prfProfileXy(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * @param {Uint8Array | number[]} white
 * @param {Uint8Array | number[]} pial
 * @param {Uint8Array | number[]} inflated
 * @param {Uint8Array | number[]} sphere
 * @param {Uint8Array | number[]} curv
 * @param {Uint8Array | number[]} area
 * @param {Uint8Array | number[] | null} [thickness]
 * @returns {any}
 */
export function readAnatomy(white, pial, inflated, sphere, curv, area, thickness) {
    let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6;
    try {
        ptr0 = passArray8ToWasm0(white, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray8ToWasm0(pial, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArray8ToWasm0(inflated, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
        ptr3 = passArray8ToWasm0(sphere, wasm.__wbindgen_malloc);
        len3 = WASM_VECTOR_LEN;
        ptr4 = passArray8ToWasm0(curv, wasm.__wbindgen_malloc);
        len4 = WASM_VECTOR_LEN;
        ptr5 = passArray8ToWasm0(area, wasm.__wbindgen_malloc);
        len5 = WASM_VECTOR_LEN;
        ptr6 = isLikeNone(thickness) ? 0 : passArray8ToWasm0(thickness, wasm.__wbindgen_malloc);
        len6 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr6) { wasm.__wbindgen_free(ptr6, len6 * 1, 1); }
        if (ptr5) { wasm.__wbindgen_free(ptr5, len5 * 1, 1); }
        if (ptr4) { wasm.__wbindgen_free(ptr4, len4 * 1, 1); }
        if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.readAnatomy(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @param {string} format
 * @returns {Apertures}
 */
export function readApertures(bytes, format) {
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.readApertures(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Apertures.__wrap(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @param {boolean} right_hemisphere
 * @returns {any}
 */
export function readBensonTemplate(bytes, right_hemisphere) {
    const val2 = +right_hemisphere;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readBensonTemplate(ptr0, len0, val2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {Float64Array}
 */
export function readFreeSurferCurv(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readFreeSurferCurv(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {any}
 */
export function readFreeSurferLabel(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readFreeSurferLabel(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {any}
 */
export function readFreeSurferSurface(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readFreeSurferSurface(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {any}
 */
export function readGifti(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readGifti(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {Run}
 */
export function readGiftiRun(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readGiftiRun(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Run.__wrap(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {any}
 */
export function readGiftiSurface(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readGiftiSurface(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {any}
 */
export function readMat(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readMat(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array | number[]} bytes
 * @returns {Float64Array}
 */
export function readOldSchoolHrf(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.readOldSchoolHrf(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {number} volumes
 * @param {number} vertices
 * @param {Float64Array | number[]} data
 * @param {Float64Array | number[]} covariates
 * @param {number} n_covariates
 * @returns {Float64Array}
 */
export function removeNoise(volumes, vertices, data, covariates, n_covariates) {
    const val3 = +volumes;
    const val4 = +vertices;
    const val5 = +n_covariates;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(covariates, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.removeNoise(val3, val4, ptr0, len0, ptr1, len1, val5);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v6 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v6;
}

/**
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {Float64Array | number[]} values
 * @returns {Uint8Array}
 */
export function writeGiftiMap(values) {
    const ptr0 = passArrayF64ToWasm0(values, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.writeGiftiMap(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * @param {Float64Array | number[]} x
 * @returns {Float64Array}
 */
export function zscore(x) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.zscore(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_debug_string_f249a2a76caa9a55: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_string_get_7ce8eee7fd327545: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_fc92fee6137d452d: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_e6325ad374eff861: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_length_186163212ffe79c3: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_b03a0fabb109b1e9: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_13de428334042d26: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_37eb45aaf5eeb820: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_cd4348290afae586: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_3512352010266e02: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_355c10c5d8f2addb: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_aaf85a9746711968: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_b8daf545a41c6aa0: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_prototypesetcall_13162965d1fe7aa3: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_c9f4893fc209f768: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_2793479888329cb6: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./samsrf_wasm_bg.js": import0,
    };
}

const AperturesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_apertures_free(ptr, 1));
const JobFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_job_free(ptr, 1));
const RunFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_run_free(ptr, 1));
const RunAccumulatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_runaccumulator_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    switch (typeof val) {
        // primitive types
        case 'number':
        case 'boolean':
        case 'undefined':
        return `${val}`;
        case 'string':
        return JSON.stringify(val);
        case 'bigint':
        return `${val}n`;
        case 'symbol':
        return val.description !== undefined
            ? `Symbol(${val.description})`
            : 'Symbol';
        case 'function':
        return typeof val.name === 'string' && val.name !== ''
            ? `Function(${val.name})`
            : 'Function';
        case 'object': {
            if (val === null) {
                return 'null';
            }
            // objects
            if (Array.isArray(val)) {
                return '[' + Array.from(val, debugString).join(', ') + ']';
            }
            // errors
            if (val instanceof Error) {
                return `${val.name}: ${val.message}\n${val.stack}`;
            }

            const toStringOutput = toString.call(val);
            // Test for built-in
            const className = /\[object ([^\]]+)\]/.exec(toStringOutput)?.[1];

            // Failed to match the standard '[object ClassName]'
            if (className === undefined) {
                return toStringOutput;
            }
            if (className === 'Object') {
                // we're a user defined class or Object
                // JSON.stringify avoids problems with cycles, and is generally much
                // easier than looping through ownProperties of `val`.
                try {
                    return 'Object(' + JSON.stringify(val) + ')';
                } catch (_) {
                    return 'Object';
                }
            }
            // TODO we could test for more things here, like `Set`s and `Map`s.
            return className;
        }
        // Per MDN: 'This list of values is exhaustive.'
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof#description
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('samsrf_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
