import releaseSpec from './release.json' with {type:'json'};

const VERSION=/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
const TARGET=/^[a-z0-9-]+$/;

export function createSyncroRelease(version,spec=releaseSpec) {
  if(!VERSION.test(version))throw new Error(`Invalid SYNcro version: ${version}`);
  const tag=`${spec.tagPrefix}${version}`,base=`https://github.com/${spec.repository}/releases/download/${tag}`;
  const targets={};
  for(const [id,definition] of Object.entries(spec.targets)) {
    if(!TARGET.test(id))throw new Error(`Invalid SYNcro release target: ${id}`);
    const archiveName=`syncro-${version}-${id}.${definition.archive}`;
    const directory=`syncro-${version}-${id}`;
    const executable=definition.executable;
    const invocation=id.startsWith('windows-')?`.\\${directory}\\${executable}`:`./${directory}/${executable}`;
    const url=`${base}/${archiveName}`;
    targets[id]=Object.freeze({
      id,label:definition.label,archiveName,
      checksumName:`${archiveName}.sha256`,validationName:`${archiveName}.validation.txt`,
      directory,executable,url,checksumUrl:`${url}.sha256`,
      selfCheck:`${invocation} self-check`,
      run:`${invocation} ${spec.run}`,
    });
  }
  return Object.freeze({version,tag,targets:Object.freeze(targets)});
}
