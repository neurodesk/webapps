// SynthSR's spatial/intensity contract, independent of UI and inference runtime.
// Ported from neurolabusc/py_synthsr (Apache-2.0); see NOTICE.
import * as nifti from 'nifti-reader-js';

const product = (dims) => dims.reduce((a, b) => a * b, 1);
const index = (x, y, z, d) => x + d[0] * (y + d[1] * z);

export function readVolume(buffer, { maxVoxels = 128 * 1024 * 1024 } = {}) {
  if (nifti.isCompressed(buffer)) buffer = nifti.decompress(buffer);
  if (!nifti.isNIFTI(buffer)) throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
  const h = nifti.readHeader(buffer);
  if (h.dims.slice(4, h.dims[0] + 1).some((d) => d > 1)) throw new Error('This operation needs a single 3D image. Extract a volume from this 4D image first.');
  const dims = h.dims.slice(1, 4);
  if (dims.some((d) => !Number.isInteger(d) || d < 2) || product(dims) > maxVoxels) throw new Error('Unsupported image dimensions.');
  const raw = nifti.readImage(h, buffer);
  const types = { 2: ['getUint8', 1], 4: ['getInt16', 2], 8: ['getInt32', 4], 16: ['getFloat32', 4], 64: ['getFloat64', 8], 256: ['getInt8', 1], 512: ['getUint16', 2], 768: ['getUint32', 4] };
  const type = types[h.datatypeCode];
  if (!type) throw new Error(`Unsupported NIfTI datatype ${h.datatypeCode}. Use a scalar intensity image.`);
  if (raw.byteLength < product(dims) * type[1]) throw new Error('The NIfTI voxel data is truncated.');
  const data = new Float32Array(product(dims));
  const view = new DataView(raw);
  const slope = h.scl_slope || 1, intercept = h.scl_slope ? h.scl_inter : 0;
  for (let i = 0; i < data.length; i++) {
    data[i] = view[type[0]](i * type[1], h.littleEndian) * slope + intercept;
    if (!Number.isFinite(data[i])) throw new Error('The image contains non-finite intensities. Clean NaN/Infinity values before synthesis.');
  }
  const unit = h.xyzt_units & 7;
  const scale = unit === 1 ? 1000 : unit === 3 ? 0.001 : 1;
  const affine = h.affine.map((row, r) => row.map((v) => r < 3 ? v * scale : v));
  if (affine.flat().some((v) => !Number.isFinite(v))) throw new Error('Invalid NIfTI affine.');
  inverse3(affine);
  return { data, dims, affine };
}

export function writeVolume({ data, dims, affine }, description = 'SynthSR synthetic T1; 1mm; not acquired T1') {
  const float = data instanceof Float32Array;
  const buffer = new ArrayBuffer(352 + data.length * (float ? 4 : 1));
  const v = new DataView(buffer);
  v.setInt32(0, 348, true); v.setInt16(40, 3, true);
  for (let a = 0; a < 7; a++) v.setInt16(42 + a * 2, dims[a] || 1, true);
  v.setInt16(70, float ? 16 : 2, true); v.setInt16(72, float ? 32 : 8, true);
  v.setFloat32(76, 1, true);
  for (let a = 0; a < 3; a++) v.setFloat32(80 + a * 4, Math.hypot(...affine.slice(0, 3).map((r) => r[a])), true);
  v.setFloat32(108, 352, true); v.setFloat32(112, 1, true); v.setUint8(123, 2);
  v.setInt16(254, 1, true);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) v.setFloat32(280 + 16 * r + 4 * c, affine[r][c], true);
  new Uint8Array(buffer, 148, 80).set(new TextEncoder().encode(description).slice(0, 79));
  new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
  if (float) for (let i = 0; i < data.length; i++) v.setFloat32(352 + i * 4, data[i], true);
  else new Uint8Array(buffer, 352).set(data);
  return buffer;
}

function inverse3(m) {
  const [[a,b,c], [d,e,f], [g,h,i]] = m;
  const det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if (Math.abs(det) < 1e-12) throw new Error('The image affine is singular.');
  return [[e*i-f*h,c*h-b*i,b*f-c*e],[f*g-d*i,a*i-c*g,c*d-a*f],[d*h-e*g,b*g-a*h,a*e-b*d]].map((r) => r.map((v) => v/det));
}

export function rasAxes(affine) {
  const inverse = inverse3(affine);
  const axes = [0,1,2].map((c) => [0,1,2].reduce((a,b) => Math.abs(inverse[a][c]) >= Math.abs(inverse[b][c]) ? a : b));
  for (let i = 0; i < 3; i++) if (!axes.includes(i)) {
    const counts = [0,1,2].map((v) => axes.filter((a) => a === v).length);
    axes[axes.lastIndexOf(counts.indexOf(Math.max(...counts)))] = i;
  }
  return axes;
}

function reflect(i, n) {
  const p = ((i % (2*n)) + 2*n) % (2*n);
  return p < n ? p : 2*n-1-p;
}

// scipy.ndimage.gaussian_filter: separable, reflect boundaries, truncate=4.
export function gaussian(data, dims, sigmas) {
  let current = data;
  for (let axis = 0; axis < 3; axis++) {
    const sigma = sigmas[axis], radius = Math.floor(4*sigma + 0.5);
    if (sigma < 1e-15 || radius === 0) continue;
    const kernel = Array.from({ length: 2*radius+1 }, (_,i) => Math.exp(-0.5*((i-radius)/sigma)**2));
    const sum = kernel.reduce((a,b) => a+b, 0);
    const out = new Float32Array(data.length);
    const stride = axis === 0 ? 1 : axis === 1 ? dims[0] : dims[0]*dims[1];
    for (let z=0; z<dims[2]; z++) for (let y=0; y<dims[1]; y++) for (let x=0; x<dims[0]; x++) {
      const pos = axis === 0 ? x : axis === 1 ? y : z, base = index(x,y,z,dims) - pos*stride;
      let value = 0;
      for (let k=-radius; k<=radius; k++) value += current[base+reflect(pos+k,dims[axis])*stride]*kernel[k+radius]/sum;
      out[index(x,y,z,dims)] = value;
    }
    current = out;
  }
  return current;
}

export function resample1mm(volume) {
  const { data, dims, affine } = volume;
  const factors = [0,1,2].map((a) => Math.sqrt(affine.slice(0,3).reduce((sum,r) => sum+r[a]*r[a],0)));
  if (factors.some((s) => s < 0.05 || s > 20)) throw new Error('Voxel spacing is outside the supported range (0.05–20 mm).');
  // Match NumPy arange(start, stop, step), including its endpoint rounding.
  const starts=factors.map((f)=>-(f-1)/(2*f)), steps=factors.map((f)=>1/f);
  const shape=dims.map((d,a)=>Math.ceil(((starts[a]+steps[a]*Math.ceil(d*factors[a]))-starts[a])/steps[a]));
  if (product(shape) > 48*1024*1024) throw new Error('The 1 mm output is too large. Crop excess background before synthesis.');
  const filtered = gaussian(data, dims, factors.map((f) => f > 1 ? 0 : 0.25/f));
  const coords = shape.map((n,a) => Array.from({length:n}, (_,i) => Math.min(dims[a]-1, Math.max(0,starts[a]+i*((starts[a]+steps[a])-starts[a])))));
  const out = new Float32Array(product(shape));
  for (let z=0; z<shape[2]; z++) {
    const fz=coords[2][z], z0=Math.floor(fz), z1=Math.min(z0+1,dims[2]-1), tz=fz-z0;
    for (let y=0; y<shape[1]; y++) {
      const fy=coords[1][y], y0=Math.floor(fy), y1=Math.min(y0+1,dims[1]-1), ty=fy-y0;
      const b00=dims[0]*(y0+dims[1]*z0), b10=dims[0]*(y1+dims[1]*z0);
      const b01=dims[0]*(y0+dims[1]*z1), b11=dims[0]*(y1+dims[1]*z1);
      for (let x=0; x<shape[0]; x++) {
        const fx=coords[0][x], x0=Math.floor(fx), x1=Math.min(x0+1,dims[0]-1), tx=fx-x0;
        const v00=filtered[b00+x0]*(1-tx)+filtered[b00+x1]*tx;
        const v10=filtered[b10+x0]*(1-tx)+filtered[b10+x1]*tx;
        const v01=filtered[b01+x0]*(1-tx)+filtered[b01+x1]*tx;
        const v11=filtered[b11+x0]*(1-tx)+filtered[b11+x1]*tx;
        out[index(x,y,z,shape)]=(v00*(1-ty)+v10*ty)*(1-tz)+(v01*(1-ty)+v11*ty)*tz;
      }
    }
  }
  const aff = affine.map((r) => [...r]);
  for (let r=0;r<3;r++) {
    for (let a=0;a<3;a++) aff[r][a] /= factors[a];
    aff[r][3] -= [0,1,2].reduce((v,a) => v+aff[r][a]*0.5*(factors[a]-1),0);
  }
  return {data:out,dims:shape,affine:aff};
}

export function prepare(volume, { ct = false } = {}) {
  const resampled = resample1mm(volume);
  const axes = rasAxes(resampled.affine);
  const flips = axes.map((a,r) => resampled.affine[r][a] < 0);
  const alignedDims = axes.map((a) => resampled.dims[a]);
  const paddedDims = alignedDims.map((s) => Math.ceil(s/32)*32);
  const offsets = paddedDims.map((s,a) => Math.floor((s-alignedDims[a])/2));
  const input = new Float32Array(product(paddedDims));
  let min = Infinity, max = -Infinity;
  for (let x=0;x<alignedDims[0];x++) for (let y=0;y<alignedDims[1];y++) for (let z=0;z<alignedDims[2];z++) {
    const src = [0,0,0];
    [x,y,z].forEach((p,a) => { src[axes[a]]=flips[a]?alignedDims[a]-1-p:p; });
    let v=resampled.data[index(...src,resampled.dims)];
    if(ct) v=Math.min(80,Math.max(0,v));
    const j=((x+offsets[0])*paddedDims[1]+y+offsets[1])*paddedDims[2]+z+offsets[2];
    input[j]=v; min=Math.min(min,v); max=Math.max(max,v);
  }
  if (max <= min) throw new Error('The input has no intensity variation after preprocessing.');
  if (input.length > resampled.data.length) { min=Math.min(min,0); max=Math.max(max,0); }
  for(let i=0;i<input.length;i++) input[i]=(input[i]-min)/(max-min);
  return { input, paddedDims, alignedDims, offsets, axes, flips, dims:resampled.dims, affine:resampled.affine };
}

export function flipInput(input, dims) {
  const out=new Float32Array(input.length), slab=dims[1]*dims[2];
  for(let x=0;x<dims[0];x++) out.set(input.subarray(x*slab,(x+1)*slab),(dims[0]-1-x)*slab);
  return out;
}

export function finish(prediction, prep, { sharpen = true } = {}) {
  const {alignedDims:d,paddedDims:p,offsets:o,axes,flips,dims,affine}=prep;
  const aligned=new Float32Array(product(d));
  for(let x=0;x<d[0];x++) for(let y=0;y<d[1];y++) for(let z=0;z<d[2];z++) aligned[index(x,y,z,d)]=prediction[((x+o[0])*p[1]+y+o[1])*p[2]+z+o[2]];
  if(sharpen) {
    const smooth=gaussian(aligned,d,[1.5,1.5,1.5]);
    for(let i=0;i<aligned.length;i++) aligned[i]=2*aligned[i]-smooth[i];
  }
  const data=new Uint8Array(product(dims));
  for(let x=0;x<d[0];x++) for(let y=0;y<d[1];y++) for(let z=0;z<d[2];z++) {
    const dst=[0,0,0]; [x,y,z].forEach((v,a)=>{dst[axes[a]]=flips[a]?d[a]-1-v:v;});
    // numpy uint8 conversion truncates, it does not round.
    data[index(...dst,dims)]=Math.max(0,Math.min(255,2*aligned[index(x,y,z,d)]));
  }
  return {data,dims,affine};
}
