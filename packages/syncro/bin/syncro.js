#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {normalize,downloadModels,checkInstallation} from '../dist/node.js';
try {
 const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean',short:'h'},'cache-dir':{type:'string'},offline:{type:'boolean'},ct:{type:'boolean'},threads:{type:'string'},resume:{type:'boolean'},lesion:{type:'string'},pathological:{type:'string'},'brain-extractor':{type:'string'},normalization:{type:'string'}}});
 if(values.help){console.log('Usage: syncro input.nii.gz output-directory [--lesion FILE] [--pathological FILE] [--ct] [--brain-extractor mindgrab|synthstrip] [--normalization greedy|ants] [--threads N] [--cache-dir PATH] [--offline] [--resume]\n       syncro download-models [--cache-dir PATH]\n       syncro self-check\nGreedy registration and MindGrab brain extraction are the defaults.\nUse --normalization ants --brain-extractor synthstrip for the methods used by the SYNcro 0.1.1 container.\n--pathological registers a second modality to the primary scan. Provide its --lesion map in that modality\'s grid.\n--resume verifies and reuses synthesis/extraction checkpoints, then reruns registration.');}
 else {
  const common={cacheDir:values['cache-dir'],offline:values.offline,onProgress:(stage,value,message)=>{if(message)process.stderr.write(`[${stage}] ${message}\n`);}};
  if(positionals[0]==='download-models'){await downloadModels(common);console.log('Models downloaded and verified.');}
  else if(positionals[0]==='self-check'){if(positionals.length!==1)throw new Error('self-check does not accept positional arguments.');console.log(JSON.stringify(await checkInstallation()));}
  else {if(positionals.length!==2)throw new Error('Provide an input image and a new output directory. Use --help for options.');
   const additional=[...(values.lesion?[{path:values.lesion,type:'binary'}]:[]),...(values.pathological?[{path:values.pathological,type:'image'}]:[])];
   const result=await normalize({...common,input:positionals[0],output:positionals[1],ct:values.ct,resume:values.resume,additional,...(values.normalization?{normalization:values.normalization}:{}),...(values['brain-extractor']?{brainExtractor:values['brain-extractor']}:{}),...(values.threads?{threads:Number(values.threads)}:{})});console.log(result.output);
  }
 }
}catch(e){console.error(e.message);process.exitCode=1;}
