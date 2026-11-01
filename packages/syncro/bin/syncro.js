#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {normalize,downloadModels,checkInstallation} from '../dist/node.js';
try {
 const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean',short:'h'},'cache-dir':{type:'string'},offline:{type:'boolean'},ct:{type:'boolean'},threads:{type:'string'},resume:{type:'boolean'},lesion:{type:'string'},normalization:{type:'string'}}});
 if(values.help){console.log('Usage: syncro input.nii.gz output-directory [--lesion FILE] [--ct] [--normalization greedy|ants] [--threads N] [--cache-dir PATH] [--offline] [--resume]\n       syncro download-models [--cache-dir PATH]\n       syncro self-check\n--normalization greedy (default) runs the web app\'s Greedy registration; ants runs ANTs SyN, the path that matches the SYNcro 0.1.1 container.\nThe packaged Node fallback uses SynthStrip. Use native SYNcro or the webapp for MindGrab and pathological-modality inputs.\n--resume verifies and reuses synthesis/extraction checkpoints, then reruns registration.');}
 else {
  const common={cacheDir:values['cache-dir'],offline:values.offline,onProgress:(stage,value,message)=>{if(message)process.stderr.write(`[${stage}] ${message}\n`);}};
  if(positionals[0]==='download-models'){await downloadModels(common);console.log('Models downloaded and verified.');}
  else if(positionals[0]==='self-check'){if(positionals.length!==1)throw new Error('self-check does not accept positional arguments.');console.log(JSON.stringify(await checkInstallation()));}
  else {if(positionals.length!==2)throw new Error('Provide an input image and a new output directory. Use --help for options.');
   const additional=values.lesion?[{path:values.lesion,type:'binary'}]:[];
   const result=await normalize({...common,input:positionals[0],output:positionals[1],ct:values.ct,resume:values.resume,additional,...(values.normalization?{normalization:values.normalization}:{}),...(values.threads?{threads:Number(values.threads)}:{})});console.log(result.output);
  }
 }
}catch(e){console.error(e.message);process.exitCode=1;}
