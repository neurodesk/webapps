// Extract-and-run instructions for an archive built by exes/node-cli, from the package's release.json.
export function portableCommand(spec, platform, filename) {
  const target = spec.targets[platform];
  if (!target) throw new Error(`${filename}: ${platform} is not a release target`);
  const directory = filename.replace(/\.(?:zip|tar\.gz)$/, '');
  if (platform.startsWith('windows-')) {
    return [
      `Expand-Archive -Path .\\${filename} -DestinationPath .`,
      `.\\${directory}\\${target.executable} ${spec.run}`,
    ].join('\n');
  }
  return [
    `tar -xzf ${filename}`,
    ...(platform.startsWith('macos-') ? [`xattr -dr com.apple.quarantine ${directory}`] : []),
    `./${directory}/${target.executable} ${spec.run}`,
  ].join('\n');
}
