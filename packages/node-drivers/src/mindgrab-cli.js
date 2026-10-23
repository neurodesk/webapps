// The command line of the native brainchop-mindgrab (brainchopC), limited to the
// options the CPU WebAssembly build runs. Usage errors read as the native ones do.

export class UsageError extends Error {}

// Native options the Node driver does not pass to the module. -cpu sets a thread
// count; the driver always runs one thread per core.
const UNSUPPORTED = new Set(['--crop', '--export-classes', '-cpu']);

/**
 * @param {string[]} argv the arguments after the program name
 * @returns {{ help: true } | { help: false, input: string, output: string, mask?: string, borderMm?: number, ct: boolean, comply: boolean }}
 */
export function parseMindgrabArgs(argv) {
  const parsed = { help: false, output: 'output.nii.gz', ct: false, comply: false };
  const inputs = [];
  const value = (i, name) => {
    if (i >= argv.length) throw new UsageError(`${name} requires a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg === '-o' || arg === '--output') parsed.output = value(++i, arg);
    else if (arg === '--ct') parsed.ct = true;
    else if (arg === '--comply') parsed.comply = true;
    else if (arg === '--mask') {
      // An optional value, as in the native parser: the next argument is the path unless it is an option.
      parsed.mask = i + 1 < argv.length && !argv[i + 1].startsWith('-') ? argv[++i] : 'mask.nii.gz';
    } else if (arg === '--border') {
      const mm = value(++i, arg);
      if (!/^\d+$/.test(mm)) throw new UsageError('--border expects a nonnegative integer');
      parsed.borderMm = Number(mm);
    } else if (arg === '-backend' || arg === '--backend') {
      const backend = value(++i, arg);
      if (backend !== 'auto' && backend !== 'cpu') throw new UsageError(`backend '${backend}' is not available; this build runs only the cpu backend`);
    } else if (UNSUPPORTED.has(arg)) {
      throw new UsageError(`${arg} is not supported by the Node CPU build`);
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`unrecognized argument '${arg}'`);
    } else inputs.push(arg);
  }
  if (inputs.length === 0) throw new UsageError('no input image given');
  if (inputs.length > 1) throw new UsageError('only one input is currently supported');
  return { ...parsed, input: inputs[0] };
}

export function mindgrabHelp(version) {
  return `usage: brainchop-mindgrab [-h] [-o OUTPUT] [--ct] [--comply]
                          [--mask [PATH]] [--border MM] [-backend auto|cpu] input

BrainChop mindgrab: skull stripping in any modality (v${version})
Node CPU build of @brainchop/mindgrab ${version} (@neurodesk/node-drivers)

positional arguments:
  input                 Input NIfTI file (.nii or .nii.gz)

options:
  -h, --help            show this help message and exit
  -o OUTPUT, --output OUTPUT
                        Output path (default: output.nii.gz)
  --ct                  CT scan: convert Hounsfield to Cormack units
  --comply              Insert compliance transform before conform
  --mask [PATH]         Save binary brain mask (default: mask.nii.gz)
  --border MM           Grow mask border in mm (default: 0)
  -backend NAME, --backend NAME
                        Select auto|cpu

Outputs ending in .gz are gzipped. Set BRAINCHOP_MINDGRAB_PACKAGE to the directory
of an installed @brainchop/mindgrab to use it instead of the one Node resolves.

Examples:
  brainchop-mindgrab input.nii.gz -o output.nii.gz
  brainchop-mindgrab input.nii.gz --ct --mask brain_mask.nii.gz`;
}
