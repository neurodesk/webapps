import { sctArgv, validateSctSpec } from './analysis-spec.js';

export async function runBrowserSct({ spec, inputs, baseUrl, onProgress = () => {}, onLog = () => {}, fetchResource = fetch }) {
    const request = validateSctSpec(spec, inputs.map(input => input.role));
    const base = new URL(baseUrl);
    const logs = [];
    const log = line => {
        logs.push(line);
        onLog(line);
    };
    const progress = (fraction, stage) => onProgress({ fraction, stage });
    const resource = async name => {
        const response = await fetchResource(new URL(name, base));
        if (!response.ok) throw new Error(`Could not load browser SCT runtime (${name}, HTTP ${response.status})`);
        return response;
    };
    progress(0.05, 'Loading browser Python…');
    const runtime = await (await resource('runtime.json')).json();
    const { loadPyodide } = await import(new URL('pyodide.mjs', base).href);
    const py = await loadPyodide({ indexURL: runtime.indexURL || (base.protocol === 'file:' ? base.pathname : base.href), stdout: log, stderr: log });
    progress(0.15, 'Loading scientific libraries…');
    await py.loadPackage(runtime.loadPackages);
    progress(0.65, 'Loading SCT analysis…');
    py.unpackArchive(new Uint8Array(await (await resource('sct.zip')).arrayBuffer()), 'zip', { extractDir: '/sct' });
    for (const wheel of runtime.wheels) {
        py.unpackArchive(new Uint8Array(await (await resource(wheel)).arrayBuffer()), 'zip', { extractDir: '/deps' });
    }
    py.FS.mkdirTree('/job/in');
    py.FS.mkdirTree('/job/out');
    const names = {};
    for (const input of inputs) {
        if (input.name !== `${input.role}.nii` && input.name !== `${input.role}.nii.gz`) throw new Error('Invalid mask filename');
        names[input.role] = input.name;
        py.FS.writeFile(`/job/in/${input.name}`, input.bytes);
    }
    await py.runPythonAsync(await (await resource('bootstrap.py')).text());
    py.globals.set('browser_command', request.command);
    py.globals.set('browser_argv', sctArgv(request, names));
    progress(0.8, 'Running SCT analysis in your browser…');
    await py.runPythonAsync("SCT_COMMANDS[browser_command](list(browser_argv)[1:] + ['-v', '0'])");
    const namesOut = request.command === 'process_segmentation'
        ? ['morphometry.csv']
        : ['lesion_analysis.xlsx', 'lesion_analysis.pkl', `lesion_label${names.lesion.endsWith('.gz') ? '.nii.gz' : '.nii'}`];
    const contentTypes = {
        'morphometry.csv': 'text/csv',
        'lesion_analysis.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'log.txt': 'text/plain',
    };
    const outputs = namesOut.map(name => ({ name, contentType: contentTypes[name] || 'application/octet-stream', bytes: py.FS.readFile(`/job/out/${name}`).slice() }));
    outputs.push({ name: 'log.txt', contentType: 'text/plain', bytes: new TextEncoder().encode(logs.join('\n')) });
    progress(1, 'Browser SCT analysis complete');
    return outputs;
}
