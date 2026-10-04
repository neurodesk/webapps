import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, cp, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBrowserSct } from '../web/js/app/browser-runtime.js';
import { SCT_IMAGE, sctArgv } from '../web/js/app/analysis-spec.js';
import { ANALYSIS_CASES, analysisFixture } from './analysis-fixtures.mjs';

const run = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const runtime = process.env.SCT_PARITY_RUNTIME ? pathToFileURL(process.env.SCT_PARITY_RUNTIME + '/') : new URL('../web/python/', import.meta.url);
const childIndex = process.argv.indexOf('--case');
if (childIndex !== -1) {
    const root = process.argv[childIndex + 1];
    const { spec, names } = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
    const inputs = await Promise.all(Object.entries(names).map(async ([role, name]) => ({ role, name, bytes: new Uint8Array(await readFile(join(root, 'in', name))) })));
    const outputs = await runBrowserSct({
        spec, inputs, baseUrl: runtime.href,
        fetchResource: async url => new Response(await readFile(fileURLToPath(url))),
    });
    for (const output of outputs) await writeFile(join(root, 'browser', output.name), output.bytes);
} else {
    const docker = process.env.DOCKER || 'docker';
    const directory = await mkdtemp(join(tmpdir(), 'sct-browser-parity-'));
    const localRuntime = await mkdtemp(join(tmpdir(), 'sct-browser-parity-runtime-'));
    await cp(fileURLToPath(runtime), localRuntime, { recursive: true });
    const manifest = JSON.parse(await readFile(new URL('../browser-runtime.json', import.meta.url), 'utf8'));
    for (const asset of manifest.assets) await copyFile(join(tmpdir(), 'sct-browser-assets', asset.sha256), join(localRuntime, asset.file));
    const config = JSON.parse(await readFile(join(localRuntime, 'runtime.json'), 'utf8'));
    delete config.indexURL;
    await writeFile(join(localRuntime, 'runtime.json'), JSON.stringify(config));
    for (const item of ANALYSIS_CASES) {
        const root = join(directory, item.id);
        for (const name of ['in', 'browser', 'native']) await mkdir(join(root, name), { recursive: true });
        const spec = { tool: 'sct', command: item.command, options: item.options };
        const names = {};
        for (const [role, kind] of Object.entries(item.roles)) {
            spec[role] = role;
            names[role] = role + (item.compressed === false ? '.nii' : '.nii.gz');
            await writeFile(join(root, 'in', names[role]), analysisFixture(kind, item.compressed !== false));
        }
        await writeFile(join(root, 'request.json'), JSON.stringify({ spec, names }));
        await run(process.execPath, [script, '--case', root], { maxBuffer: 5 * 1024 * 1024, env: { ...process.env, SCT_PARITY_RUNTIME: localRuntime } });
        const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
        const direct = await run(docker, ['run', '--rm', '--network', 'none', ...user, '-v', `${root}:/job`, SCT_IMAGE,
            ...sctArgv(spec, names, { input: '/job/in', output: '/job/native' })], { maxBuffer: 5 * 1024 * 1024 });
        await writeFile(join(root, 'native.log'), direct.stdout + direct.stderr);
    }
    console.log(`Browser parity artifacts: ${directory}`);
    const comparison = fileURLToPath(new URL('./compare_browser_analysis.py', import.meta.url));
    const compared = await run(docker, ['run', '--rm', '--network', 'none', '-v', `${directory}:/job`, '-v', `${comparison}:/compare.py:ro`, SCT_IMAGE,
        '/opt/spinalcordtoolbox-7.3.3/python/envs/venv_sct/bin/python3.10', '/compare.py', ...['--report-only', '--exact'].filter(flag => process.argv.includes(flag))], { maxBuffer: 1024 * 1024 });
    console.log(compared.stdout.trim());
}
