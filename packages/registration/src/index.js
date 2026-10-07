// ANTsPy 0.6.1 type_of_transform='SyN', with explicit seed and float precision.
export function synArguments(fixed, moving, prefix, seed=42) {
  if(!Number.isSafeInteger(seed)||seed<1)throw new Error('Registration seed must be a positive integer.');
  return ['--dimensionality','3','--float','1','--random-seed',String(seed),
    '-r',`[${fixed},${moving},1]`,
    '--metric',`mattes[${fixed},${moving},1,32,regular,0.2]`,
    '--transform','Affine[0.25]','--convergence','2100x1200x1200x0',
    '--smoothing-sigmas','3x2x1x0','--shrink-factors','4x2x2x1',
    '--metric',`mattes[${fixed},${moving},1,32]`,
    '--transform','SyN[0.2,3,0]','--convergence','[40x20x0,1e-7,8]',
    '--smoothing-sigmas','2x1x0','--shrink-factors','4x2x1',
    '-u','0','-z','1','--output',`[${prefix},${prefix}brain.nii.gz]`,'--verbose','1'];
}

// register() writes its inputs as .nii because ANTs picks the reader by file name, so gzipped
// NIfTI is inflated first. Works wherever DecompressionStream exists: browsers, workers, Node 18+.
export async function inflateNifti(bytes) {
  const input = new Uint8Array(bytes);
  if (input.length < 2 || input[0] !== 0x1f || input[1] !== 0x8b) return input;
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function createRegistration({createModule,wasmBinary,onLog=()=>{}}) {
  const module=await createModule({noInitialRun:true,wasmBinary,print:onLog,printErr:onLog});
  function call(args) {
    const code=module.callMain(args);
    if(code!==0)throw new Error(`ANTs failed (exit ${code}). See processing log.`);
  }
  let next=0;
  const jobs=new Set();
  return {
    importTransforms({fixed,transforms}) {
      const dir=`/job-${next++}`,prefix=dir+'/result-',fixedPath=dir+'/fixed.nii';
      for(const name of ['0GenericAffine.mat','1Warp.nii.gz','1InverseWarp.nii.gz'])if(!transforms[name])throw new Error('Missing transform: '+name);
      module.FS.mkdir(dir);jobs.add(dir);module.FS.writeFile(fixedPath,new Uint8Array(fixed));
      for(const name of ['0GenericAffine.mat','1Warp.nii.gz','1InverseWarp.nii.gz'])module.FS.writeFile(prefix+name,new Uint8Array(transforms[name]));
      return {dir,prefix,fixedPath,transforms};
    },
    register({fixed,moving,seed=42}) {
      const dir=`/job-${next++}`;module.FS.mkdir(dir);jobs.add(dir);
      const fixedPath=dir+'/fixed.nii',movingPath=dir+'/moving.nii',prefix=dir+'/result-';
      module.FS.writeFile(fixedPath,new Uint8Array(fixed));module.FS.writeFile(movingPath,new Uint8Array(moving));
      call(synArguments(fixedPath,movingPath,prefix,seed));
      const names=['0GenericAffine.mat','1Warp.nii.gz','1InverseWarp.nii.gz'];
      const transforms=Object.fromEntries(names.map(name=>[name,module.FS.readFile(prefix+name)]));
      const warped=module.FS.readFile(prefix+'brain.nii.gz');
      return {warped,transforms,dir,prefix,fixedPath,seed};
    },
    apply({registration,moving,interpolation='linear',fill=0}) {
      if(!['linear','nearest'].includes(interpolation)||!Number.isFinite(fill))throw new Error('Invalid resampling settings.');
      const path=registration.dir+'/additional.nii',out=registration.dir+'/warped.nii.gz';
      module.FS.writeFile(path,new Uint8Array(moving));
      try {
        call(['--apply',registration.fixedPath,path,out,interpolation,String(fill),
          registration.prefix+'1Warp.nii.gz',registration.prefix+'0GenericAffine.mat']);
        return module.FS.readFile(out);
      } finally {
        for(const file of [path,out])try{module.FS.unlink(file);}catch{}
      }
    },
    release(registration) {
      if(!jobs.has(registration.dir))return;
      for(const name of module.FS.readdir(registration.dir))if(!['.','..'].includes(name))module.FS.unlink(registration.dir+'/'+name);
      module.FS.rmdir(registration.dir);jobs.delete(registration.dir);
    },
    memoryBytes:()=>module.HEAPU8?.byteLength ?? null,
  };
}
