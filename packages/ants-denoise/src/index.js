// ANTs DenoiseImage (adaptive non-local means, Manjón et al. 2010) in its own WebAssembly module.
// The module runs one ITK thread, so the same input gives the same bytes on every host.

// ANTs reads by file name, so gzipped NIfTI is inflated first.
export async function inflateNifti(bytes) {
  const input = new Uint8Array(bytes);
  if (input.length < 2 || input[0] !== 0x1f || input[1] !== 0x8b) {
    return input;
  }
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const NOISE_MODELS = ['Gaussian', 'Rician'];

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Denoising ${name} must be a positive integer.`);
  }
  return String(value);
}

// The DenoiseImage command line for one 3D image; every setting is explicit.
export function denoiseArguments({
  input,
  output,
  mask = null,
  noiseModel = 'Gaussian',
  shrinkFactor = 1,
  patchRadius = 1,
  searchRadius = 2,
}) {
  if (!NOISE_MODELS.includes(noiseModel)) {
    throw new Error(`Denoising noise model must be one of ${NOISE_MODELS.join(', ')}.`);
  }
  const args = ['-d', '3', '-i', input];
  if (mask) {
    args.push('-x', mask);
  }
  args.push('-n', noiseModel);
  args.push('-s', positiveInteger(shrinkFactor, 'shrink factor'));
  args.push('-p', positiveInteger(patchRadius, 'patch radius'));
  args.push('-r', positiveInteger(searchRadius, 'search radius'));
  args.push('-o', output);
  args.push('-v', '0');
  return args;
}

export async function createDenoiser({ createModule, wasmBinary, onLog = () => {} }) {
  const module = await createModule({ noInitialRun: true, wasmBinary, print: onLog, printErr: onLog });
  // The ITK-Wasm toolchain's pre-js replaces print and printErr with console output plus a capture
  // buffer, so the captured text is passed to onLog after each run.
  function forwardLog() {
    for (const text of [module.getModuleStdout?.(), module.getModuleStderr?.()]) {
      for (const line of (text ?? '').split('\n')) {
        if (line) {
          onLog(line);
        }
      }
    }
    module.resetModuleStdout?.();
    module.resetModuleStderr?.();
  }
  forwardLog();
  let next = 0;
  // The toolchain builds without C++ exception catching, so an ITK error (an unreadable file,
  // a mask on another grid) aborts the module instead of returning an exit code. Its state is then
  // undefined: the denoiser refuses further work and the caller creates a new one.
  let aborted = null;
  return {
    // image and mask are NIfTI bytes, gzipped or not. The mask (nonzero after conversion to unsigned
    // char) selects the patch centres that are denoised; voxels farther than the patch radius from it
    // keep their values up to float rounding. Returns uncompressed float32 NIfTI-1 bytes.
    async denoise({ image, mask = null, noiseModel = 'Gaussian', shrinkFactor = 1, patchRadius = 1, searchRadius = 2 }) {
      if (aborted) {
        throw new Error(`The denoise module aborted earlier (${aborted}). Create a new denoiser.`);
      }
      const dir = `/denoise-${next++}`;
      const input = `${dir}/input.nii`;
      const maskPath = mask ? `${dir}/mask.nii` : null;
      const output = `${dir}/denoised.nii`;
      const args = denoiseArguments({ input, output, mask: maskPath, noiseModel, shrinkFactor, patchRadius, searchRadius });
      // ANTs picks the image reader by file name, so gzipped NIfTI is inflated before it is written as .nii.
      const imageBytes = await inflateNifti(image);
      const maskBytes = mask ? await inflateNifti(mask) : null;
      module.FS.mkdir(dir);
      try {
        module.FS.writeFile(input, imageBytes);
        if (maskBytes) {
          module.FS.writeFile(maskPath, maskBytes);
        }
        let code;
        // In Node an Emscripten abort also sets process.exitCode. The abort becomes the error thrown
        // here, so the caller decides how the process ends.
        const exitCode = globalThis.process?.exitCode;
        const stack = module.stackSave();
        try {
          code = module.callMain(args);
        } catch (error) {
          if (globalThis.process) {
            globalThis.process.exitCode = exitCode;
          }
          aborted = error instanceof Error ? error.message : `exception ${error}`;
          throw new Error(`ANTs DenoiseImage aborted (${aborted}). See processing log.`, { cause: error });
        } finally {
          if (!aborted) module.stackRestore(stack);
          forwardLog();
        }
        if (code !== 0) {
          throw new Error(`ANTs DenoiseImage failed (exit ${code}). See processing log.`);
        }
        return module.FS.readFile(output);
      } finally {
        if (!aborted) {
          for (const name of module.FS.readdir(dir)) {
            if (name !== '.' && name !== '..') {
              module.FS.unlink(`${dir}/${name}`);
            }
          }
          module.FS.rmdir(dir);
        }
      }
    },
    memoryBytes: () => module.HEAPU8?.byteLength ?? null,
  };
}
