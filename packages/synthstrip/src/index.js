// Spatial contract ported from FreeSurfer SynthStrip / Surfa. See NOTICE.
const size = d => d.reduce((a,b)=>a*b,1);
const idx = (x,y,z,d) => x+d[0]*(y+d[1]*z);

// Six-connected labeling and hole filling, as scipy.ndimage.label/fill_holes.
export function cleanMask(mask, dims) {
  const [nx,ny,nz]=dims, plane=nx*ny, n=mask.length;
  const labels=new Int32Array(n), queue=new Int32Array(n);
  let label=0, largest=0, largestCount=0;
  function neighbors(i, visit) {
    const x=i%nx, y=Math.floor(i/nx)%ny, z=Math.floor(i/plane);
    if(x)visit(i-1);if(x+1<nx)visit(i+1);
    if(y)visit(i-nx);if(y+1<ny)visit(i+nx);
    if(z)visit(i-plane);if(z+1<nz)visit(i+plane);
  }
  for(let i=0;i<n;i++)if(mask[i]&&!labels[i]) {
    label++;let head=0,tail=1;queue[0]=i;labels[i]=label;
    while(head<tail)neighbors(queue[head++],j=>{if(mask[j]&&!labels[j]){labels[j]=label;queue[tail++]=j;}});
    if(tail>largestCount){largestCount=tail;largest=label;}
  }
  if(!largest)throw new Error('SynthStrip produced an empty brain mask.');
  const result=Uint8Array.from(labels,v=>v===largest?1:0);
  labels.fill(0);let head=0,tail=0;
  for(let z=0;z<nz;z++)for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
    if(x&&y&&z&&x<nx-1&&y<ny-1&&z<nz-1)continue;
    const i=idx(x,y,z,dims);if(!result[i]&&!labels[i]){labels[i]=1;queue[tail++]=i;}
  }
  while(head<tail)neighbors(queue[head++],j=>{if(!result[j]&&!labels[j]){labels[j]=1;queue[tail++]=j;}});
  for(let i=0;i<n;i++)if(!labels[i])result[i]=1;
  return result;
}

export function prepareStrip(volume) {
  const {data,dims,affine}=volume;
  if(dims.length!==3||dims.some(d=>!Number.isInteger(d)||d<2)||data.length!==size(dims))throw new Error('Invalid 3D volume.');
  let min=Infinity,max=-Infinity;
  for(const v of data){if(!Number.isFinite(v))throw new Error('Non-finite image intensity.');min=Math.min(min,v);max=Math.max(max,v);}
  if(max<=min)throw new Error('Brain extraction requires a nonconstant image.');
  // Match Surfa's closest cardinal orientation, preserving voxel geometry.
  const spacing=[0,1,2].map(a=>Math.hypot(...affine.slice(0,3).map(r=>r[a])));
  const remaining=new Set([0,1,2]), ras=[];
  for(let world=0;world<3;world++) {
    const axis=[...remaining].sort((a,b)=>Math.abs(affine[world][b]/spacing[b])-Math.abs(affine[world][a]/spacing[a]))[0];
    ras.push(axis);remaining.delete(axis);
  }
  const perm=[ras[0],ras[2],ras[1]], sign=[-1,-1,1];
  const flip=perm.map((a,i)=>Math.sign(affine[[0,2,1][i]][a])!==sign[i]);
  const orientedDims=perm.map(a=>dims[a]), sp=perm.map(a=>spacing[a]);
  const resize=sp.some(s=>Math.abs(s-1)>1e-5);
  const resampledDims=orientedDims.map((d,a)=>resize?Math.ceil(d*sp[a]):d);
  const resampled=new Float32Array(size(resampledDims));
  const sourceCoord=(c,a)=>resize?(c-resampledDims[a]/2)/sp[a]+orientedDims[a]/2:c;
  const originalIndex=(c)=>{
    const src=[0,0,0];for(let a=0;a<3;a++)src[perm[a]]=flip[a]?orientedDims[a]-1-c[a]:c[a];
    return idx(...src,dims);
  };
  const lo=[...resampledDims],hi=[-1,-1,-1];
  for(let z=0;z<resampledDims[2];z++)for(let y=0;y<resampledDims[1];y++)for(let x=0;x<resampledDims[0];x++) {
    const c=[x,y,z].map((v,a)=>Math.floor(sourceCoord(v,a)+0.5));
    const value=c.some((v,a)=>v<0||v>=orientedDims[a])?0:data[originalIndex(c)];
    resampled[idx(x,y,z,resampledDims)]=value;
    if(value>0)for(const [a,v] of [x,y,z].entries()){lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);}
  }
  if(hi.some(v=>v<0))throw new Error('No positive image voxels to conform.');
  const crop=lo.map((v,a)=>hi[a]-v+1), modelDims=crop.map(d=>Math.min(320,Math.max(192,Math.ceil(d/64)*64)));
  const shift=modelDims.map((d,a)=>{const delta=(d-crop[a])/2;return delta>=0?Math.floor(delta):Math.ceil(delta);});
  const input=new Float32Array(size(modelDims)); // C order, directly suitable for ONNX.
  for(let z=0;z<modelDims[2];z++)for(let y=0;y<modelDims[1];y++)for(let x=0;x<modelDims[0];x++) {
    const c=[x,y,z].map((v,a)=>v-shift[a]);
    if(c.some((v,a)=>v<0||v>=crop[a]))continue;
    input[x*modelDims[1]*modelDims[2]+y*modelDims[2]+z]=resampled[idx(...c.map((v,a)=>v+lo[a]),resampledDims)];
  }
  const sorted=input.slice().sort(), minimum=sorted[0];
  const position=(sorted.length-1)*0.99, lower=Math.floor(position), fraction=position-lower;
  const percentile=sorted[lower]*(1-fraction)+sorted[Math.min(lower+1,sorted.length-1)]*fraction-minimum;
  if(!(percentile>0))throw new Error('The conformed image has no usable intensity range.');
  for(let i=0;i<input.length;i++)input[i]=Math.min(1,Math.max(0,(input[i]-minimum)/percentile));
  return {input,modelDims,perm,flip,orientedDims,resampledDims,sp,resize,lo,shift,volume};
}

export function finishStrip(sdt, prep) {
  const {volume,modelDims,perm,flip,orientedDims,resampledDims,sp,resize,lo,shift}=prep;
  if(sdt.length!==size(modelDims))throw new Error('SynthStrip returned an unexpected output shape.');
  let maximum=-Infinity;for(const v of sdt){if(!Number.isFinite(v))throw new Error('SynthStrip returned non-finite values.');maximum=Math.max(maximum,v);}
  if(Math.trunc(maximum)<=1)throw new Error('SynthStrip distance field is invalid or requires unsupported boundary extension.');
  const sample=(x,y,z)=>sdt[x*modelDims[1]*modelDims[2]+y*modelDims[2]+z];
  const distance=new Float32Array(volume.data.length), mask=new Uint8Array(distance.length);
  for(let z=0;z<volume.dims[2];z++)for(let y=0;y<volume.dims[1];y++)for(let x=0;x<volume.dims[0];x++) {
    const original=[x,y,z];
    const c=perm.map((a,i)=>{let v=flip[i]?orientedDims[i]-1-original[a]:original[a];if(resize)v=(v-orientedDims[i]/2)*sp[i]+resampledDims[i]/2;return v-lo[i]+shift[i];});
    let value=100;
    if(c.every((v,a)=>v>=0&&v<=modelDims[a]-1)) {
      const b=c.map(Math.floor),w=c.map((v,a)=>v-b[a]);value=0;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) {
        const weight=(dx?w[0]:1-w[0])*(dy?w[1]:1-w[1])*(dz?w[2]:1-w[2]);
        if(weight)value+=weight*sample(Math.min(b[0]+dx,modelDims[0]-1),Math.min(b[1]+dy,modelDims[1]-1),Math.min(b[2]+dz,modelDims[2]-1));
      }
    }
    const i=idx(x,y,z,volume.dims);distance[i]=value;mask[i]=value<1?1:0;
  }
  const cleaned=cleanMask(mask,volume.dims),brain=new Float32Array(mask.length);
  let fill=0;for(const v of volume.data)fill=Math.min(fill,v);
  for(let i=0;i<brain.length;i++)brain[i]=cleaned[i]?volume.data[i]:fill;
  const geometry={dims:volume.dims,affine:volume.affine};
  return {brain:{...geometry,data:brain},mask:{...geometry,data:cleaned},distance:{...geometry,data:distance}};
}

export async function runSynthstrip({volume,loadModel,createSession,Tensor,onProgress=()=>{}}) {
  onProgress(0,'Conforming image for brain extraction…');const prep=prepareStrip(volume);
  const model=await loadModel();const session=await createSession(model.bytes,prep.modelDims);
  let input,outputs;
  try {
    input=new Tensor('float32',prep.input,[1,1,...prep.modelDims]);
    onProgress(0.2,'Extracting brain…');outputs=await session.run({[session.inputNames[0]]:input});
    const result=finishStrip(await outputs[session.outputNames[0]].getData(),prep);
    onProgress(1,'Brain extraction complete');return {...result,provenance:{modelHash:model.hash,modelDims:prep.modelDims,border:1}};
  } finally {input?.dispose();if(outputs)for(const v of Object.values(outputs))v.dispose();await session.release();}
}
