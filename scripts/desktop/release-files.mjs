import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join, resolve } from 'node:path';
import { fileHash } from '../../packages/desktop/src/bundle.js';

export async function prepareReleaseFiles(archive, destination, { version, platform, partBytes = 1_900_000_000, kind = 'desktop', modelsIncluded = true }) {
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
  const windows = platform === 'windows-x64';
  const concatenate = parts.length < 2 ? '' : windows
    ? `cmd /c copy /b ${parts.map(part => part.filename).join('+')} ${filename}\n`
    : `cat ${parts.map(part => part.filename).join(' ')} > ${filename}\n`;
  const extract = filename.endsWith('.sif') ? `apptainer run ${filename} --verify` : filename.endsWith('.zip')
    ? windows ? `Expand-Archive ${filename} -DestinationPath NeurodeskWebapps` : `unzip ${filename}`
    : `tar -xzf ${filename}`;
  const command = `${concatenate}${extract}`;
  const installation = `${filename}.install.txt`;
  await writeFile(join(destination, installation), `Neurodesk Webapps ${version} for ${platform}\n\nDownload every file below into one folder. ${modelsIncluded ? 'All models and runtime dependencies are included. Transfer the complete set to the offline machine.' : 'Models are not included. An internet connection is needed when a model is first used.'}\n\n${parts.map(part => part.filename).join('\n')}\n\nRun in ${windows ? 'PowerShell' : 'a terminal'} from that folder:\n\n${command}\n\nOpen the extracted Neurodesk Webapps application. For scheduler jobs, see STANDALONE.md included in the application resources.\n`);
  const result = {
    kind, platform, version, modelsIncluded, bytes,
    url: parts.length === 1 ? parts[0].url : baseUrl + installation,
    sha256: parts.length === 1 ? sha256 : await fileHash(join(destination, installation)),
    ...(parts.length > 1 ? { parts, archiveSha256: sha256, archiveFilename: filename } : {}),
    command,
  };
  await writeFile(join(destination, `${platform}${modelsIncluded ? '' : '-without-models'}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(destination, `${filename}.sha256`), `${sha256}  ${filename}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [archive, destination, version, platform, kind] = process.argv.slice(2);
  if (!archive || !destination || !version || !platform) throw new Error('Usage: release-files.mjs ARCHIVE OUTPUT VERSION PLATFORM');
  console.log(await prepareReleaseFiles(archive, destination, { version, platform, kind }));
}
