import releaseSpec from './release.json' with {type:'json'};

const VERSION=/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
const TARGET=/^[a-z0-9-]+$/;

// Download, check and unpack or install one release asset, then the command that runs it.
const INSTALL={
  zip:target=>({
    invocation:`.\\${target.directory}\\${target.executable}`,
    setup:[`Expand-Archive -Path .\\${target.archiveName} -DestinationPath .`],
  }),
  'tar.gz':target=>({
    invocation:`./${target.directory}/${target.executable}`,
    setup:[
      `curl -fLO ${target.url}`,
      `curl -fLO ${target.checksumUrl}`,
      `sha256sum -c ${target.checksumName}`,
      `tar -xzf ${target.archiveName}`,
    ],
  }),
  // The installer puts the command in /usr/local/bin, which is on macOS's default PATH.
  pkg:target=>({
    invocation:target.executable,
    setup:[
      `curl -fLO ${target.url}`,
      `curl -fLO ${target.checksumUrl}`,
      `shasum -a 256 -c ${target.checksumName}`,
      `sudo installer -pkg ${target.archiveName} -target /`,
    ],
  }),
};

export function createSyncroRelease(version,spec=releaseSpec) {
  if(!VERSION.test(version))throw new Error(`Invalid SYNcro version: ${version}`);
  const tag=`${spec.tagPrefix}${version}`;
  const base=`https://github.com/${spec.repository}/releases/download/${tag}`;
  const targets={};
  for(const [id,definition] of Object.entries(spec.targets)) {
    if(!TARGET.test(id))throw new Error(`Invalid SYNcro release target: ${id}`);
    const install=INSTALL[definition.archive];
    if(!install)throw new Error(`Unsupported SYNcro release archive: ${definition.archive}`);
    const archiveName=`syncro-${version}-${id}.${definition.archive}`;
    const url=`${base}/${archiveName}`;
    const target={
      id,label:definition.label,archive:definition.archive,archiveName,
      checksumName:`${archiveName}.sha256`,validationName:`${archiveName}.validation.txt`,
      directory:`syncro-${version}-${id}`,executable:definition.executable,url,checksumUrl:`${url}.sha256`,
    };
    const {invocation,setup}=install(target);
    targets[id]=Object.freeze({
      ...target,
      setup:Object.freeze(setup),
      selfCheck:`${invocation} self-check`,
      run:`${invocation} ${spec.run}`,
    });
  }
  return Object.freeze({version,tag,targets:Object.freeze(targets)});
}
