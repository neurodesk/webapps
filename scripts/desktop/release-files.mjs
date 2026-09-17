import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join, resolve } from 'node:path';
import { fileHash } from '../../packages/desktop/src/bundle.js';

export async function prepareReleaseFiles(archive, destination, { version, platform, partBytes = 1_900_000_000, kind = 'desktop' }) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes >= 2 ** 31) throw new Error('Invalid release part size');
  const filename = basename(archive);
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error('Archive filename must be safe in shell commands');
  const bytes = (await stat(archive)).size;
  const sha256 = await fileHash(archive);
  const baseUrl = `https://github.com/neurodesk/webapps/releases/download/webapps-v${version}/`;
  await mkdir(destination, { recursive: true });
  const parts = [];
  for (let start = 0, index = 1; start < bytes; start += partBytes, index++) {
    const name = bytes <= partBytes ? filename : `${filename}.part${String(index).padStart(2, '0')}`;
    const path = join(destination, name);
    if (resolve(path) === resolve(archive)) throw new Error('Release directory must differ from archive directory');
    await pipeline(createReadStream(archive, { start, end: Math.min(start + partBytes, bytes) - 1 }), createWriteStream(path));
    parts.push({ filename: name, url: baseUrl + name, bytes: (await stat(path)).size, sha256: await fileHash(path) });
  }
  const models = kind === 'models';
  const windows = platform === 'windows-x64';
  const concatenate = parts.length < 2 ? '' : windows
    ? `cmd /c copy /b ${parts.map(part => part.filename).join('+')} ${filename}\n`
    : `cat ${parts.map(part => part.filename).join(' ')} > ${filename}\n`;
  // The pack entries are bare hashes, so they are extracted into their own directory.
  const extract = models ? `mkdir models\ntar -xzf ${filename} -C models` : filename.endsWith('.sif') ? `apptainer run ${filename} --verify` : filename.endsWith('.zip')
    ? windows ? `Expand-Archive ${filename} -DestinationPath NeurodeskWebapps` : `unzip ${filename}`
    : `tar -xzf ${filename}`;
  const command = `${concatenate}${extract}`;
  const installation = `${filename}.install.txt`;
  const heading = models ? `Neurodesk Webapps ${version} model pack` : `Neurodesk Webapps ${version} for ${platform}`;
  const purpose = models
    ? 'The pack holds every model for every platform. Install it on a machine that has no internet access.'
    : 'Models are not included. The application downloads a model the first time it is needed. Install the model pack as well for a fully offline machine.';
  const closing = models
    ? 'Keep the extracted models folder in a permanent location. Set NEURODESK_MODELS_DIR to its absolute path before starting Neurodesk Webapps. On Windows, join the parts with cmd /c copy /b instead of cat.'
    : 'Open the extracted Neurodesk Webapps application. For scheduler jobs, see STANDALONE.md included in the application resources.';
  await writeFile(join(destination, installation), `${heading}\n\nDownload every file below into one folder. ${purpose}\n\n${parts.map(part => part.filename).join('\n')}\n\nRun in ${windows ? 'PowerShell' : 'a terminal'} from that folder:\n\n${command}\n\n${closing}\n`);
  const result = {
    kind, platform, version, bytes,
    url: parts.length === 1 ? parts[0].url : baseUrl + installation,
    sha256: parts.length === 1 ? sha256 : await fileHash(join(destination, installation)),
    ...(parts.length > 1 ? { parts, archiveSha256: sha256, archiveFilename: filename } : {}),
    command,
  };
  await writeFile(join(destination, `${platform}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(destination, `${filename}.sha256`), `${sha256}  ${filename}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [archive, destination, version, platform, kind] = process.argv.slice(2);
  if (!archive || !destination || !version || !platform) throw new Error('Usage: release-files.mjs ARCHIVE OUTPUT VERSION PLATFORM');
  console.log(await prepareReleaseFiles(archive, destination, { version, platform, kind }));
}
