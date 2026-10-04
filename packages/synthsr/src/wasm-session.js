import model from './gpu-model.json' with { type: 'json' };
import { planGpuGraph } from './gpu-session.js';
import { WasmActivation } from './wasm-activation.js';

export const WASM_IMPLEMENTATION = 'synthsr-streamed-fp32-v1';
export const needsStreamedWasm = dims => dims.reduce((a,b)=>a*b,1)>8*1024*1024;
const product = dims => dims.reduce((a,b)=>a*b,1);
const text = value => new TextEncoder().encode(value);
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;
};
const varint = value => {
  let n=BigInt.asUintN(64,BigInt(value));const bytes=[];
  do{bytes.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);return Uint8Array.from(bytes);
};
const integer = (field,value) => concat([varint(field*8),varint(value)]);
const bytes = (field,value) => concat([varint(field*8+2),varint(value.length),value]);
const string = (field,value) => bytes(field,text(value));
const float = (field,value) => {
  const raw=new Uint8Array(4);new DataView(raw.buffer).setFloat32(0,value,true);
  return concat([varint(field*8+5),raw]);
};
function attribute(name,value) {
  const data=[string(1,name)];
  if(Array.isArray(value))data.push(integer(20,7),...value.map(v=>integer(8,v)));
  else if(typeof value==='string')data.push(integer(20,3),string(4,value));
  else if(['alpha','epsilon','momentum'].includes(name))data.push(integer(20,1),float(2,value));
  else data.push(integer(20,2),integer(3,value));
  return concat(data);
}
function valueInfo(name,channels,dims,depthName='depth') {
  const shape=[1,channels,depthName,...dims.slice(1)].map(d=>bytes(1,typeof d==='string'?string(2,d):integer(1,d)));
  return concat([string(1,name),bytes(2,bytes(1,concat([integer(1,1),bytes(2,concat(shape))])))]);
}

// Small ONNX graphs reuse the exact initializer bytes from the verified model.
// Only the spatial depth is dynamic. ORT still executes the original operators.
export function layerModel(node,raw) {
  const initializerNames=node.inputs.filter(name=>model.tensors[name]);
  const makeNode=(op,inputs,output,attrs={})=>concat([
    ...inputs.map(name=>string(1,name)),string(2,output),string(4,op),
    ...Object.entries(attrs).map(([name,value])=>bytes(5,attribute(name,value))),
  ]);
  const nodes=[makeNode(node.op,node.inputs,node.elu?'pre_elu':node.output,node.attrs)];
  if(node.elu)nodes.push(makeNode('Elu',['pre_elu'],node.output,{alpha:1}));
  const graph=concat([
    ...nodes.map(n=>bytes(1,n)),string(2,node.name),
    ...initializerNames.map(name=>{
      const t=model.tensors[name];return bytes(5,concat([
        ...t.dims.map(d=>integer(1,d)),integer(2,1),string(8,name),bytes(9,raw.subarray(t.offset,t.offset+t.bytes)),
      ]));
    }),
    bytes(11,valueInfo(node.inputs[0],node.inputShape.channels,node.inputShape.dims)),
    ...(node.op==='Add'?[bytes(11,valueInfo(node.inputs[1],node.inputShape.channels,node.inputShape.dims))]:[]),
    bytes(12,valueInfo(node.output,node.shape.channels,node.shape.dims,'output_depth')),
  ]);
  return concat([integer(1,8),bytes(7,graph),bytes(8,integer(2,13))]);
}

// Split individual operators, not the image/network. A convolution reads one
// real neighboring slice on each side; only its core output is retained. Pool
// and nearest resize boundaries stay aligned. Every later layer sees the whole
// preceding activation, preserving the full network's receptive field.
export function slabPlan(node, maxElements=8*1024*1024) {
  const [depth,height,width]=node.shape.dims, [inputDepth,ih,iw]=node.inputShape.dims;
  const scale=node.op==='MaxPool'?2:node.op==='Resize'?.5:1;
  const halo=node.op==='Conv'?Math.floor(node.kernel/2):0;
  const alignment=node.op==='Resize'?2:1;
  const perDepth=Math.max(height*width*node.shape.channels,ih*iw*node.inputShape.channels*scale);
  const step=Math.max(alignment,Math.floor((Math.floor(maxElements/perDepth)-2*halo)/alignment)*alignment);
  const slabs=[];
  for(let start=0;start<depth;start+=step) {
    const end=Math.min(depth,start+step),inputStart=Math.max(0,start*scale-halo),inputEnd=Math.min(inputDepth,end*scale+halo);
    slabs.push({start,end,inputStart,inputEnd,outputOffset:halo?start-inputStart:0});
  }
  return slabs;
}

function sliceChannels(source,shape,start,end) {
  const [depth,height,width]=shape.dims, plane=height*width, count=(end-start)*plane;
  const result=new Float32Array(shape.channels*count);
  for(let c=0;c<shape.channels;c++)source.copyTo(result,c*count,c*depth*plane+start*plane,c*depth*plane+end*plane);
  return result;
}

export async function createStreamedWasmSession(raw,dims,ort,{onProgress=()=>{},maxElements=8*1024*1024}={}) {
  raw=raw instanceof ArrayBuffer?new Uint8Array(raw):new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
  if(raw.byteLength!==model.bytes || digest!==model.sha256)throw new Error('CPU executor requires the validated SynthSR model.');
  const plan=planGpuGraph(dims),sessions=[];
  let released=false,running=false,activation;
  try {
    for(const node of plan.nodes)sessions.push(await ort.InferenceSession.create(layerModel(node,raw),{
      executionProviders:['wasm'],graphOptimizationLevel:'all',enableCpuMemArena:false,enableMemPattern:false,
    }));
    activation=plan.slots.map(s=>new WasmActivation(s.bytes/4,Math.min(maxElements,8*1024*1024)));
  }catch(error){await Promise.allSettled(sessions.map(s=>s.release()));throw error;}
  return {
    inputNames:[model.input],outputNames:[model.output],implementation:WASM_IMPLEMENTATION,
    async run(feeds) {
      if(released||running)throw new Error('SynthSR CPU session is released or busy.');
      const input=feeds[model.input];
      if(input?.type!=='float32'||input.dims.join()!==[1,1,...dims].join())throw new Error('CPU input does not match the session shape.');
      running=true;
      try {
        const inputData=await input.getData();
        if(inputData.length!==product(dims))throw new Error('CPU input size mismatch.');
        activation[plan.inputSlot].set(inputData);
        for(let i=0;i<plan.nodes.length;i++) {
          const node=plan.nodes[i],session=sessions[i],target=activation[node.slot];
          onProgress(i+1,plan.nodes.length);
          for(const slab of slabPlan(node,maxElements)) {
            const chunk=sliceChannels(activation[node.inputSlots[0]],node.inputShape,slab.inputStart,slab.inputEnd);
            const chunkDims=[1,node.inputShape.channels,slab.inputEnd-slab.inputStart,...node.inputShape.dims.slice(1)];
            const tensors={[node.inputs[0]]:new ort.Tensor('float32',chunk,chunkDims)};
            if(node.op==='Add')tensors[node.inputs[1]]=new ort.Tensor('float32',sliceChannels(activation[node.inputSlots[1]],node.inputShape,slab.inputStart,slab.inputEnd),chunkDims);
            let outputs;
            try {
              outputs=await session.run(tensors);
              const result=outputs[node.output],values=await result.getData();
              const [,,chunkDepth,height,width]=result.dims,plane=height*width;
              if(height!==node.shape.dims[1]||width!==node.shape.dims[2]||result.dims[1]!==node.shape.channels||chunkDepth<slab.outputOffset+slab.end-slab.start)throw new Error('CPU layer output shape mismatch.');
              for(let c=0;c<node.shape.channels;c++) {
                const offset=(c*chunkDepth+slab.outputOffset)*plane;
                target.set(values.subarray(offset,offset+(slab.end-slab.start)*plane),(c*node.shape.dims[0]+slab.start)*plane);
              }
            }finally{Object.values(tensors).forEach(t=>t.dispose());if(outputs)Object.values(outputs).forEach(t=>t.dispose());}
          }
        }
        const result=new Float32Array(product(dims));
        activation[plan.outputSlot].copyTo(result,0,0,result.length);
        return {[model.output]:{dims:[1,1,...dims],type:'float32',getData:async()=>result,dispose(){}}};
      }finally{running=false;}
    },
    async release(){if(!released){released=true;activation=null;await Promise.all(sessions.map(s=>s.release()));}},
  };
}
