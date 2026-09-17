import { basename } from 'node:path';

const platforms = {
  'macos-arm64': 'macOS · Apple silicon',
  'windows-x64': 'Windows · x64',
  'linux-x64': 'Linux · x64',
  'linux-x64-apptainer': 'Apptainer · Linux x64',
};

function downloadCommands(download, { windows, mac, folder }) {
  const files = download.parts?.length ? download.parts : [download];
  const archive = download.archiveFilename || basename(new URL(download.url).pathname);
  const hash = download.archiveSha256 || download.sha256;
  const commands = windows
    ? ["$ErrorActionPreference = 'Stop'", `New-Item -ItemType Directory -Path '${folder}' | Out-Null`, `Set-Location '${folder}'`]
    : ['set -e', `mkdir '${folder}'`, `cd '${folder}'`];
  for (const file of files) {
    const name = basename(new URL(file.url).pathname);
    commands.push(windows
      ? `Invoke-WebRequest -Uri '${file.url}' -OutFile '${name}'`
      : `curl --fail --location --retry 3 --output '${name}' '${file.url}'`);
  }
  if (files.length > 1) {
    const names = files.map(file => basename(new URL(file.url).pathname));
    if (windows) {
      commands.push(`cmd /c copy /b ${names.join('+')} ${archive}`, "if ($LASTEXITCODE -ne 0) { throw 'Archive reassembly failed' }");
    } else commands.push(`cat ${names.map(name => `'${name}'`).join(' ')} > '${archive}'`);
  }
  commands.push(windows
    ? `if ((Get-FileHash '${archive}' -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${hash}') { throw 'Archive checksum mismatch' }`
    : `printf '%s  %s\\n' '${hash}' '${archive}' | ${mac ? 'shasum -a 256' : 'sha256sum'} -c -`);
  return { commands, archive };
}

function renderPlatform(download) {
  const windows = download.platform === 'windows-x64';
  const mac = download.platform === 'macos-arm64';
  const { commands, archive } = downloadCommands(download, { windows, mac, folder: `webapps-${download.version}-${download.platform}` });
  let instructions;
  if (mac) {
    commands.push(`ditto -x -k '${archive}' .`, 'mkdir -p "$HOME/Applications"', 'cp -R neurodesk-webapps.app "$HOME/Applications/"', 'open "$HOME/Applications/neurodesk-webapps.app"');
    instructions = 'Run in Terminal. This installs the app in your user Applications folder. Quit an older copy before updating. If macOS blocks the first launch, review the app in System Settings → Privacy & Security and use Open Anyway if you trust this release.';
  } else if (windows) {
    commands.push(`Expand-Archive -LiteralPath '${archive}' -DestinationPath 'app'`, "Start-Process '.\\app\\neurodesk-webapps.exe'");
    instructions = 'Run in PowerShell. This is a portable application: keep the entire extracted app folder together and launch neurodesk-webapps.exe. You can move that folder to a permanent location and create a shortcut.';
  } else if (download.kind === 'container') {
    commands.push(`apptainer run '${archive}' --verify`);
    instructions = 'Run in a Linux shell with Apptainer installed. The combined SIF is ready to use; no extraction is needed. For an interactive graphical session, run the same command without --verify. For batch jobs, pass --job /path/to/job.json --output /path/to/results and bind the required directories.';
  } else {
    commands.push('mkdir app', `tar -xzf '${archive}' -C app --strip-components=1`, './app/neurodesk-webapps');
    instructions = 'Run in a Linux graphical session. Keep the entire extracted app folder together; launch app/neurodesk-webapps as your regular user. You can move the folder to a permanent location.';
  }
  return `<details>\n<summary>${platforms[download.platform] || download.platform}</summary>\n\n${instructions}\n\n\`\`\`${windows ? 'powershell' : 'bash'}\n${commands.join('\n')}\n\`\`\`\n\n</details>`;
}

function renderModels(models) {
  const folder = `webapps-${models.version}-models`;
  const shell = downloadCommands(models, { windows: false, mac: false, folder });
  shell.commands.push('mkdir models', `tar -xzf '${shell.archive}' -C models`, 'export NEURODESK_MODELS_DIR="$PWD/models"');
  const powershell = downloadCommands(models, { windows: true, folder });
  powershell.commands.push("New-Item -ItemType Directory -Path 'models' | Out-Null", `tar -xzf '${powershell.archive}' -C models`, "$env:NEURODESK_MODELS_DIR = (Resolve-Path 'models').Path");
  const instructions = 'The pack holds every model and is identical on all platforms. Install it when the machine has no internet access. Keep the extracted models folder in a permanent location and set NEURODESK_MODELS_DIR to its absolute path before starting the application. Set the variable in your shell profile, your job script, or your scheduler module so every session sees it. On macOS, use shasum -a 256 in place of sha256sum. On a shared HPC filesystem, one extracted pack can be bind-mounted read-only into every job.';
  return `<details>\n<summary>Model pack · every platform · optional</summary>\n\n${instructions}\n\n\`\`\`bash\n${shell.commands.join('\n')}\n\`\`\`\n\n\`\`\`powershell\n${powershell.commands.join('\n')}\n\`\`\`\n\n</details>`;
}

export function renderInstallationNotes(downloads, models) {
  const sections = downloads.map(renderPlatform);
  if (models) sections.push(renderModels(models));
  return `## Download and install\n\nChoose your platform below, then add the optional model pack for offline use. Run its commands from a writable folder. Each block creates a new folder, downloads the exact release files, joins split archives in order, checks SHA-256, and installs or opens the application. Do not extract individual parts. Allow space for the downloaded parts, combined archive, and extracted app. After a successful installation, you can delete the parts and archive; keep the SIF for Apptainer.\n\n${sections.join('\n\n')}\n`;
}
