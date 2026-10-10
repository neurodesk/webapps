/* @ts-self-types="./preprocessing.d.ts" */

/**
 * BET brain extraction (FSL-BET2 algorithm via qsm-core).
 *
 * Accepts Float32 input and converts to Float64 internally to avoid
 * doubling memory usage on the JS side.
 *
 * # Arguments
 * * `data` - Flattened Float32 magnitude volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
 * * `fractional_intensity` - Intensity threshold (0.0-1.0, smaller = larger brain, default: 0.5)
 * * `progress_callback` - JS function(current, total) for progress updates
 *
 * # Returns
 * Binary mask as Uint8Array (1 = brain, 0 = background)
 * @param {Float32Array} data
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} vsx
 * @param {number} vsy
 * @param {number} vsz
 * @param {number} fractional_intensity
 * @param {Function} progress_callback
 * @returns {Uint8Array}
 */
export function bet_brain_extract(data, nx, ny, nz, vsx, vsy, vsz, fractional_intensity, progress_callback) {
    const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.bet_brain_extract(ptr0, len0, nx, ny, nz, vsx, vsy, vsz, fractional_intensity, progress_callback);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * 3D bilateral filter denoising for MRI volumes.
 *
 * # Arguments
 * * `data` - Flattened Float32 volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `spatial_radius` - Spatial kernel half-size (default: 2, gives 5x5x5 kernel)
 * * `sigma_spatial` - Spatial Gaussian sigma (default: 1.5)
 * * `sigma_intensity` - Intensity Gaussian sigma (0.0 = auto-estimate from noise)
 * @param {Float32Array} data
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} spatial_radius
 * @param {number} sigma_spatial
 * @param {number} sigma_intensity
 * @returns {Float32Array}
 */
export function bilateral_denoise(data, nx, ny, nz, spatial_radius, sigma_spatial, sigma_intensity) {
    const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.bilateral_denoise(ptr0, len0, nx, ny, nz, spatial_radius, sigma_spatial, sigma_intensity);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * N4ITK bias field correction for 3D MRI volumes.
 *
 * # Arguments
 * * `data` - Flattened Float32 volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `vox_x`, `vox_y`, `vox_z` - Voxel sizes in mm
 * * `shrink_factor` - Downsampling factor for speed (default: 4)
 * * `max_iterations` - Maximum iterations per level (default: 50)
 * * `convergence_threshold` - Convergence threshold (default: 0.001)
 * @param {Float32Array} data
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} vox_x
 * @param {number} vox_y
 * @param {number} vox_z
 * @param {number} shrink_factor
 * @param {number} max_iterations
 * @param {number} convergence_threshold
 * @returns {Float32Array}
 */
export function n4_bias_correct(data, nx, ny, nz, vox_x, vox_y, vox_z, shrink_factor, max_iterations, convergence_threshold) {
    const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.n4_bias_correct(ptr0, len0, nx, ny, nz, vox_x, vox_y, vox_z, shrink_factor, max_iterations, convergence_threshold);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Non-local means denoising for 3D MRI volumes.
 *
 * # Arguments
 * * `data` - Flattened Float32 volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `search_radius` - Search window half-size (default: 5)
 * * `patch_radius` - Patch half-size (default: 1, gives 3x3x3 patches)
 * * `h` - Smoothing parameter (0.0 = auto-estimate from noise)
 * @param {Float32Array} data
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {number} search_radius
 * @param {number} patch_radius
 * @param {number} h
 * @returns {Float32Array}
 */
export function nlm_denoise(data, nx, ny, nz, search_radius, patch_radius, h) {
    const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.nlm_denoise(ptr0, len0, nx, ny, nz, search_radius, patch_radius, h);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_dcc2662fa17a72cf: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./preprocessing_bg.js": import0,
    };
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
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

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

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

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('preprocessing_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
