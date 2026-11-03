// Prepare the published OpenADS diffusion example outside the source repository.
// Upload the output folder to neurodeskorg/webapps, then supply its immutable
// revision with --hf-revision to generate the two ready-to-register examples.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'hf-revision': { type: 'string' }, local: { type: 'boolean', default: false }, upstream: { type: 'boolean', default: false } } });
const revision = values['hf-revision'];
if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Use an immutable 40-character Hugging Face commit.');
if (!process.env.TMPDIR) throw new Error('Set TMPDIR to the storage volume.');
const output = join(process.env.TMPDIR, 'calmar-diffusion-example');
await mkdir(output, { recursive: true });
const commit = '6c378d1ae36278c9351c247e00286f19e0a893ac';
const upstream = `https://raw.githubusercontent.com/farialab/OpenADS/${commit}`;
const subject = '02e8eb42';
const expected = {
  dwi: 'cb8f9ff8a33b61b86e499be74ac4a85a422a5dc5719099f06b37717448e3bb6a',
  adc: 'bbca038a04804e6bdc800cf6666330bf2c5480f6b979c94145472d0d261aaf1e',
  b0: '51d3f0d5bb919c66243a25f8f5d429099d3d691be981fc6243ec49cbc06417fd',
};
const files = [];
for (const [role, suffix] of [['dwi', 'DWI'], ['adc', 'ADC'], ['b0', 'b0']]) {
  const name = `${subject}_${suffix}.nii.gz`;
  const sourceUrl = `${upstream}/assets/examples/pwi/sub-${subject}/${name}`;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`${response.status}: ${sourceUrl}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected[role]) throw new Error(`${name}: checksum mismatch`);
  const raw = gunzipSync(bytes);
  const littleEndian = raw.readInt32LE(0) === 348;
  const int16 = offset => littleEndian ? raw.readInt16LE(offset) : raw.readInt16BE(offset);
  const float32 = offset => littleEndian ? raw.readFloatLE(offset) : raw.readFloatBE(offset);
  if (!littleEndian && raw.readInt32BE(0) !== 348) throw new Error(`${name}: expected NIfTI-1`);
  const dimensions = Array.from({ length: int16(40) }, (_, i) => int16(42 + 2 * i));
  if (dimensions.length > 3 && dimensions.slice(3).some(n => n !== 1)) throw new Error(`${name}: expected one 3D contrast, got ${dimensions}`);
  await writeFile(join(output, name), bytes);
  files.push({ role, name, sourceUrl, sha256, bytes: bytes.length,
    dimensions, spacing: [float32(80), float32(84), float32(88)] });
}
const licenseResponse = await fetch(`${upstream}/LICENSE`);
if (!licenseResponse.ok) throw new Error('Could not retrieve upstream redistribution terms.');
await writeFile(join(output, 'LICENSE-OpenADS.txt'), await licenseResponse.text());
await writeFile(join(output, 'provenance.json'), JSON.stringify({ repository: 'https://github.com/farialab/OpenADS', commit, subject, files }, null, 2) + '\n');
await writeFile(join(output, 'README.md'), `# CALMaR diffusion example\n\nPublished OpenADS example sub-${subject}, unchanged from commit ${commit}. DWI, ADC and b0 are from the same published subject. No age, sex or time-post-onset is provided here; leave patient context blank. These data are for non-commercial research under the accompanying JHU Non-Profit Research Software License Agreement. Preserve LICENSE-OpenADS.txt and upstream attribution when redistributing.\n\nUpstream: https://github.com/farialab/OpenADS/tree/${commit}/assets/examples/pwi/sub-${subject}\n`);
if (revision || values.upstream || values.local) {
  const bundle = roles => files.filter(file => roles.includes(file.role)).map(({ role, name, sha256, bytes, sourceUrl }) => ({
    role, name, sha256, bytes,
    url: revision ? `https://huggingface.co/datasets/neurodeskorg/webapps/resolve/${revision}/examples/calmar/stroke-diffusion/${name}` : sourceUrl,
  }));
  const examples = [['stroke-dwi-adc', 'Stroke DWI + ADC', ['dwi', 'adc']], ['stroke-dwi-b0', 'Stroke DWI + b0', ['dwi', 'b0']]].map(([id, label, roles]) => ({
    id, label,
    description: 'Published OpenADS stroke example, sub-02e8eb42. Non-commercial research data. Review and confirm the computed lesion before reporting. Demographic information is unavailable.',
    expectedResult: 'An editable SEALS lesion candidate from the diffusion inputs, followed by mask confirmation and reporting.',
    files: bundle(roles),
  }));
  await writeFile(join(output, 'examples.json'), JSON.stringify(examples, null, 2) + '\n');
  if (values.local) {
    const catalog = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));
    const local = [...catalog.filter(item => !examples.some(example => example.id === item.id)), ...examples];
    await writeFile(new URL('../web/examples.json', import.meta.url), JSON.stringify(local, null, 2) + '\n');
  }
}
console.log(JSON.stringify({ output, files }, null, 2));
