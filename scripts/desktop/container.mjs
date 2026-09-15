import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyNiftiOffset } from './check-nifti.mjs';
import { prepareReleaseFiles } from './release-files.mjs';

const root = resolve(import.meta.dirname, '../..');
const context = join(root, 'packages/desktop/release');
await mkdir(context, { recursive: true });
await cp(join(root, 'packages/desktop/container'), context, { recursive: true });
await writeFile(join(context, '.dockerignore'), '**\n!Dockerfile\n!entrypoint.sh\n!linux-unpacked/\n!linux-unpacked/**\n');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const image = 'neurodesk-webapps:test';
run('docker', ['build', '-t', image, context]);
const reportDirectory = join(root, 'container-reports');
await mkdir(reportDirectory, { recursive: true });
await chmod(reportDirectory, 0o777);
run('docker', ['run', '--rm', '--network=none', '-e', 'NEURODESK_SOFTWARE_RENDERING=1', image, '--verify'], { timeout: 120000 });
const env = ['NEURODESK_CONTAINER=1', 'NEURODESK_SOFTWARE_RENDERING=1', 'NEURODESK_EXECUTABLE=/opt/neurodesk/neurodesk-webapps', 'NEURODESK_BUNDLE=/opt/neurodesk/resources/offline', `NEURODESK_TEST_REPORT=${root}/container-reports`];
// Test the actual container with the network namespace disconnected. The host
// Node executable and checkout are test tools, not runtime dependencies.
run('docker', ['run', '--rm', '--network=none', '--shm-size=2g', '-v', `${root}:${root}`, '-v', `${process.execPath}:/usr/local/bin/node:ro`, '-w', root, ...env.flatMap(value => ['-e', value]), '--entrypoint', '/usr/bin/xvfb-run', image, '-a', '/usr/local/bin/node', 'scripts/desktop/smoke.mjs']);
const jobs = join(root, 'container-jobs');
await mkdir(jobs, { recursive: true });
await chmod(jobs, 0o777);
await cp(join(root, 'packages/desktop/jobs/niimath.json'), join(jobs, 'job.json'));
await cp(join(root, 'exes/synthseg/test/fixtures/small.nii.gz'), join(jobs, 'input.nii.gz'));
run('docker', ['run', '--rm', '--network=none', '--shm-size=2g', '-e', 'NEURODESK_SOFTWARE_RENDERING=1', '-e', 'NEURODESK_USER_DATA=/data/docker-profile', '-v', `${jobs}:/data`, image, '--job', '/data/job.json', '--output', '/data/docker-results']);
const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'))).version;
const sif = join(root, `packages/desktop/release/webapps-${version}-linux-x64.sif`);
run('docker', ['save', '-o', join(context, 'image.tar'), image]);
run('apptainer', ['build', sif, `docker-archive:${join(context, 'image.tar')}`]);
run('apptainer', ['run', '--cleanenv', '--env', 'NEURODESK_SOFTWARE_RENDERING=1', '--bind', `${jobs}:/data`, sif, '--job', '/data/job.json', '--output', '/data/apptainer-results']);
for (const directory of ['docker-results', 'apptainer-results']) {
  const report = JSON.parse(await readFile(join(jobs, directory, 'job-result.json')));
  verifyNiftiOffset(await readFile(join(jobs, 'input.nii.gz')), await readFile(join(jobs, directory, report.downloads[0].filename)), 1);
  if (report.app !== 'niimath' || report.downloads.length !== 1 || report.downloads[0].bytes < 352) throw new Error(`Invalid ${directory}`);
}
await writeFile(join(root, 'container-reports/batch.json'), JSON.stringify({ docker: 'passed with network=none', apptainer: 'passed', app: 'niimath' }, null, 2));
await prepareReleaseFiles(sif, join(root, 'packages/desktop/release/github'), { version, platform: 'linux-x64-apptainer', kind: 'container' });
