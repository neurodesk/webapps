import synthsrManifest from '@neurodesk/synthsr/manifest' with {type:'json'};
const synthsrAsset=synthsrManifest.assets.find(asset=>asset.filename==='synthsr-v2.onnx');
export const assets={
  synthsr:{...synthsrAsset,url:synthsrManifest.base_url+synthsrAsset.filename},
};
