import {createSyncroRelease} from '../../../packages/syncro/release.mjs';

export const syncroRelease=createSyncroRelease(__SYNCRO_PACKAGE_VERSION__);

function element(root,id) {
  const value=root.querySelector(`#${id}`);
  if(!value)throw new Error(`Missing SYNcro standalone control: ${id}`);
  return value;
}

// Controls are named after the target's system: macos-arm64 fills #nativeMacosDownload.
function controlPrefix(id) {
  const system=id.split('-')[0];
  return `native${system[0].toUpperCase()}${system.slice(1)}`;
}

export function configureNativeDownloads(root,release=syncroRelease) {
  for(const target of Object.values(release.targets)) {
    const prefix=controlPrefix(target.id);
    const link=element(root,`${prefix}Download`);
    link.href=target.url;
    link.download=target.archiveName;
    link.textContent=`Download ${target.archiveName}`;
    element(root,`${prefix}Checksum`).href=target.checksumUrl;
    element(root,`${prefix}Commands`).textContent=[...target.setup,target.selfCheck,target.run].join('\n');
  }
  const npm=`neurodesk-syncro-${release.version}.tgz`;
  const npmLink=element(root,'packageLink');
  npmLink.href=`downloads/${npm}`;
  npmLink.download=true;
  npmLink.textContent=`Download npm package · ${release.version}`;
  element(root,'downloadCommand').textContent=`curl -fLO https://webapps.neurodesk.org/syncro/downloads/${npm}`;
  element(root,'installCommand').textContent=`ONNXRUNTIME_NODE_INSTALL=skip npm install -g --prefix "$HOME/.local" ./${npm}`;
}
