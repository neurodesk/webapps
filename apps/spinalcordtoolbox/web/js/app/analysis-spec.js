export const SCT_IMAGE = 'vnmd/spinalcordtoolbox_7.3.3@sha256:974f6019415df81465ac03102d27b8a23945155b96a45e7b5f525a3d0d55ab83';
export const SCT_VERSION = '7.3';
export const SCT_COMMANDS = ['process_segmentation', 'analyze_lesion'];

export function validateSctSpec(spec, partNames) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be an object');
    if (spec.tool !== 'sct') throw new Error('tool must be sct');
    if (!SCT_COMMANDS.includes(spec.command)) throw new Error('unknown SCT command');
    const morphometry = spec.command === 'process_segmentation';
    const allowed = morphometry ? ['tool', 'command', 'cord', 'options'] : ['tool', 'command', 'cord', 'lesion', 'options'];
    for (const key of Object.keys(spec)) {
        if (!allowed.includes(key)) throw new Error(`unknown field '${key}'`);
    }
    const roles = morphometry ? ['cord'] : ['lesion', ...('cord' in spec ? ['cord'] : [])];
    for (const role of roles) {
        if (spec[role] !== role) throw new Error(`${role} must reference the '${role}' part`);
        if (!partNames.includes(role)) throw new Error(`part '${role}' was not received`);
    }
    if (roles.length !== partNames.length) throw new Error('unused file parts');
    const options = spec.options === undefined ? {} : spec.options;
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
    for (const [key, value] of Object.entries(options)) {
        const valid = morphometry && (
            (['perSlice', 'angleCorrection'].includes(key) && typeof value === 'boolean') ||
            (key === 'slices' && validSlices(value))
        );
        if (!valid) throw new Error(`invalid SCT option '${key}'`);
    }
    return { tool: 'sct', command: spec.command, ...Object.fromEntries(roles.map(role => [role, role])), options: { ...options } };
}

function validSlices(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 1000 &&
        value.split(',').every(range => {
            if (!/^\d+(?::\d+)?$/.test(range)) return false;
            const values = range.split(':').map(Number);
            return values.every(n => n <= 4294967295) && (values.length === 1 || values[0] <= values[1]);
        });
}

export function sctArgv(spec, fileNames = {}, paths = { input: '/job/in', output: '/job/out' }) {
    const input = role => `${paths.input}/${fileNames[role] || `${role}.nii.gz`}`;
    const args = spec.command === 'process_segmentation'
        ? ['sct_process_segmentation', '-i', input('cord'), '-o', `${paths.output}/morphometry.csv`]
        : ['sct_analyze_lesion', '-m', input('lesion'), ...(spec.cord ? ['-s', input('cord')] : []), '-ofolder', paths.output];
    for (const [key, flag] of [['perSlice', '-perslice'], ['angleCorrection', '-angle-corr'], ['slices', '-z']]) {
        if (key in spec.options) {
            const value = spec.options[key];
            args.push(flag, typeof value === 'boolean' ? (value ? '1' : '0') : value);
        }
    }
    return args;
}
