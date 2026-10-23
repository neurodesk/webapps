#!/usr/bin/env node
// Runs a mri2vid command line on the app's pinned example for every case in cases.mjs and
// holds each video to what the web app wrote in Chromium (browser-reference.json):
//
// - the same container, coded size, frame count, presentation timestamps (the frame rate)
//   and key frames;
// - VP9 frames that decode to the browser's: the luma PSNR between the command line's and
//   the browser's decoded frames, and the command line's PSNR against the exact frames the
//   shared pipeline renders, must both clear MIN_PSNR_DB on every frame, and the latter must
//   be within QUALITY_MARGIN_DB of the browser's own.
//
// Chromium's MP4 is H.264, which the command line cannot write; for that case the container
// facts are compared with the browser's and the frames with the rendered source.
//
// The slice label is drawn with a different font in each, so annotated frames are compared
// outside the label box, and inside it the label must be drawn in both.
//
// A synthetic DICOM series then proves the command line converts DICOM with its bundled
// dcm2niix: every frame must match the series as this checkout reads and renders it.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeVideo, inspectVideo } from '../src/inspect.js';
import { labelPixels, labelBox, psnr, renderedLuma } from './frame-comparison.mjs';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { convertDicom, parseOptions } from '../src/node.js';
import { readDicomSeries } from '../src/readers/dicom.js';
import { readNifti } from '../src/readers/nifti.js';
import { CASES, caseArguments, exampleFile, referenceVideo } from './cases.mjs';

// Measured on these cases (lowest frame per case): the browser's VP9 frames are 35.3-40.7 dB
// from the rendered source, the command line's 35.2-40.5 dB, and the two decoded videos are
// 35.9-40.7 dB apart. Against the sagittal case's frames, the neighbouring slice scores
// 27.0 dB, a window narrowed to 80 % 23.0 dB, the next frame 20.0 dB and the flipped
// orientation 16.4 dB. 30 dB fails all of those and leaves 5 dB for encoder differences.
const MIN_PSNR_DB = 30;
// The command line may not be more than this much worse than the browser against the source.
const QUALITY_MARGIN_DB = 3;
const MIN_LABEL_PIXELS = 20;

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/mri2vid.js', import.meta.url))];
const reference = JSON.parse(await readFile(new URL('./browser-reference.json', import.meta.url), 'utf8'));

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const lowest = (values) => Math.min(...values);
const dB = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} dB` : 'identical');

const work = await mkdtemp(join(tmpdir(), 'mri2vid-cli-check-'));
try {
  const volumes = new Map();
  for (const item of CASES) {
    const recorded = reference.cases[item.id];
    if (!recorded) throw new Error(`browser-reference.json has no case ${item.id}; run validation/browser-reference.mjs`);
    const input = await exampleFile(item.example);
    if (!volumes.has(input)) volumes.set(input, await readNifti(new Uint8Array(await readFile(input)).buffer, 'example'));
    const output = join(work, item.id);
    const started = performance.now();
    const run = spawnSync(command[0], [...command.slice(1), input, output, ...caseArguments(item.parameters)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`INFO ${item.id}: ${run.stderr.trim().split('\n').at(-1)} (${seconds} s)`);

    const settings = parseOptions(item.parameters);
    const expectedName = `T1_head_${settings.orientation}.${settings.format}`;
    const names = await readdir(output);
    check(names.length === 1 && names[0] === expectedName, `${item.id}: writes ${names.join(', ')} as the app names its download (${expectedName})`);
    const bytes = await readFile(join(output, names[0]));
    const facts = await inspectVideo(bytes);
    const browser = recorded.video;
    check(facts.container === browser.container, `${item.id}: ${facts.container} container, as the browser's`);
    check(facts.codec === 'vp9', `${item.id}: VP9 (the browser wrote ${recorded.codec})`);
    check(facts.width === browser.width && facts.height === browser.height, `${item.id}: ${facts.width}x${facts.height} coded size, browser ${browser.width}x${browser.height}`);
    check(facts.frames === browser.frames, `${item.id}: ${facts.frames} frames, browser ${browser.frames}`);
    check(JSON.stringify(facts.timestampsUs) === JSON.stringify(browser.timestampsUs), `${item.id}: frame timestamps match the browser's at ${settings.fps} fps`);
    check(JSON.stringify(facts.keyFrames) === JSON.stringify(browser.keyFrames), `${item.id}: key frames at ${facts.keyFrames.join(', ')}, as the browser's`);

    const source = renderedLuma(volumes.get(input), settings);
    const decoded = await decodeVideo(bytes);
    check(decoded.length === source.length, `${item.id}: ${decoded.length} decoded frames for ${source.length} selected slices`);
    const outside = (k) => (settings.annotate ? (i) => !labelBox(source[k].fH, source[k].width)(i) : () => true);
    const vsSource = lowest(decoded.map((f, k) => psnr(f.y, source[k].y, outside(k))));
    check(vsSource >= MIN_PSNR_DB, `${item.id}: every frame ${dB(vsSource)} or better against the rendered source (>= ${MIN_PSNR_DB} dB)`);

    if (recorded.video.codec === 'vp9') {
      const browserDecoded = await decodeVideo(await referenceVideo(recorded));
      const browserVsSource = lowest(browserDecoded.map((f, k) => psnr(f.y, source[k].y, outside(k))));
      const vsBrowser = lowest(decoded.map((f, k) => psnr(f.y, browserDecoded[k].y, outside(k))));
      check(vsSource >= browserVsSource - QUALITY_MARGIN_DB, `${item.id}: as close to the source as the browser's ${dB(browserVsSource)}, within ${QUALITY_MARGIN_DB} dB`);
      check(vsBrowser >= MIN_PSNR_DB, `${item.id}: every frame ${dB(vsBrowser)} or better against the browser's decoded frame (>= ${MIN_PSNR_DB} dB)`);
      if (settings.annotate) {
        const ink = (frames) => lowest(frames.map((f, k) => labelPixels(f.y, source[k].y, labelBox(source[k].fH, source[k].width))));
        const [cliInk, browserInk] = [ink(decoded), ink(browserDecoded)];
        check(cliInk >= MIN_LABEL_PIXELS && browserInk >= MIN_LABEL_PIXELS, `${item.id}: every frame carries a slice label (${cliInk} label pixels at least; browser ${browserInk})`);
      }
    }
  }

  const series = dicomSeries({ series: 7, slices: 6 });
  const dicom = join(work, 'dicom');
  await mkdir(dicom);
  for (const file of series) await writeFile(join(dicom, file.name), file.buffer);
  const settings = parseOptions({ orientation: 'axial' });
  const output = join(work, 'dicom-video');
  const run = spawnSync(command[0], [...command.slice(1), dicom, output, ...caseArguments({ orientation: 'axial' })], { encoding: 'utf8' });
  check(run.status === 0, `dicom: the command line converts a DICOM series (exit ${run.status}${run.status ? `: ${run.stderr.trim().split('\n').at(-1)}` : ''})`);
  if (run.status === 0) {
    const files = series.map((file) => ({ name: file.name, buffer: file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength) }));
    const source = renderedLuma(await readDicomSeries(files, { convertDicom }), settings);
    const [name] = await readdir(output);
    const decoded = await decodeVideo(await readFile(join(output, name)));
    check(decoded.length === source.length, `dicom: ${decoded.length} decoded frames for ${source.length} rendered frames`);
    const vsSource = lowest(decoded.map((f, k) => psnr(f.y, source[k].y, () => true)));
    check(vsSource >= MIN_PSNR_DB, `dicom: every frame ${dB(vsSource)} or better against the rendered series (>= ${MIN_PSNR_DB} dB)`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} mri2vid command-line checks` : 'PASS mri2vid command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
