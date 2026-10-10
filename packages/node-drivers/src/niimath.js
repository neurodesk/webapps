// Runs one niimath command line under Node over in-memory files.
//
// Each call instantiates a fresh module, so no file or heap state leaks from
// one command into the next, and a runtime abort cannot poison later calls.
// The caller supplies the Emscripten factory (the default export of a
// niimath.js build) so a command line runs exactly the build its web app pins.

export class NiimathError extends Error {
  constructor(message, { code, log }) {
    super(message);
    this.name = 'NiimathError';
    this.code = code;
    this.log = log;
  }
}

/**
 * @param {(config: object) => Promise<object>} createModule default export of `niimath.js`
 * @param {string[]} args niimath argv without the program name; file names are relative to `/`
 * @param {{ inputs?: Record<string, Uint8Array>, outputs?: string[] }} files
 * @returns {Promise<{ outputs: Record<string, Uint8Array>, log: string[] }>}
 */
export async function runNiimath(createModule, args, { inputs = {}, outputs = [] } = {}) {
  const log = [];
  const module = await createModule({
    noInitialRun: true,
    thisProgram: 'niimath',
    print: line => log.push(line),
    printErr: line => log.push(line),
  });
  for (const [name, bytes] of Object.entries(inputs)) {
    module.FS_createDataFile('/', name, bytes, true, true);
  }
  // Emscripten's Node glue records exit() in process.exitCode; keep the host's.
  const hostExitCode = process.exitCode;
  let code;
  try {
    // callMain prepends the program name to the array it is given.
    code = module.callMain([...args]);
  } catch (error) {
    if (typeof error?.status !== 'number') throw error;
    code = error.status;
  } finally {
    process.exitCode = hostExitCode;
  }
  if (code !== 0) {
    throw new NiimathError(`niimath ${args.join(' ')} exited with ${code}. ${log.join(' ')}`.trim(), { code, log });
  }
  const read = {};
  for (const name of outputs) {
    try {
      read[name] = module.FS_readFile(name);
    } catch {
      // niimath gzips NIfTI output unless told otherwise, so out.nii arrives as out.nii.gz.
      const hint = exists(module, `${name}.gz`) ? ` It wrote ${name}.gz; ask for that name.` : '';
      throw new NiimathError(`niimath ${args.join(' ')} wrote no ${name}.${hint} ${log.join(' ')}`.trim(), { code, log });
    }
  }
  return { outputs: read, log };
}

function exists(module, name) {
  try {
    module.FS_readFile(name);
    return true;
  } catch {
    return false;
  }
}
