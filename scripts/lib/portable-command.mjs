// Install or extract-and-run instructions for a release built by exes/node-cli, from the package's release.json.
export function portableCommand(spec, platform, filename) {
  const target = spec.targets[platform];
  if (!target) throw new Error(`${filename}: ${platform} is not a release target`);
  if (filename.endsWith('.pkg')) {
    return [
      `sudo installer -pkg ${filename} -target /`,
      `${target.executable} self-check`,
      `${target.executable} ${spec.run}`,
    ].join('\n');
  }
  const directory = filename.replace(/\.(?:zip|tar\.gz)$/, '');
  if (platform.startsWith('windows-')) {
    return [
      `Expand-Archive -Path .\\${filename} -DestinationPath .`,
      `.\\${directory}\\${target.executable} ${spec.run}`,
    ].join('\n');
  }
  return [
    `tar -xzf ${filename}`,
    `./${directory}/${target.executable} ${spec.run}`,
  ].join('\n');
}

// The platform a release asset installs on, or null. Ad hoc test installers end in -adhoc.pkg and never
// match; with a release spec only the kind it names counts, so a macOS .pkg replaces an older archive.
export function releasePlatform(spec, filename) {
  const match = filename.match(/-(macos-arm64|linux-x64|windows-x64)\.(pkg|tar\.gz|zip)$/);
  if (!match) return null;
  const [, platform, extension] = match;
  if (spec && spec.targets[platform]?.archive !== extension) return null;
  return platform;
}
