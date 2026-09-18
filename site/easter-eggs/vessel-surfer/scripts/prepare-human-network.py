"""Build an attributed game asset from IXI322's published vessel segmentation.
Requires numpy, scipy, scikit-image and nibabel. No invented vessel geometry.
Run: python scripts/prepare-human-network.py /path/to/Dataset.zip
"""
import sys, zipfile, hashlib, json, gzip, struct
from pathlib import Path
import numpy as np
import nibabel as nib
from scipy import ndimage as ndi
from skimage.morphology import skeletonize
from skimage.measure import marching_cubes
from collections import deque

out=Path(__file__).resolve().parents[1]/'public'/'data'
name='IXI322-IOP-0891-MRA.nii.gz'
raw=zipfile.ZipFile(sys.argv[1]).read(name)
(out/'ixi322-vessels.nii.gz').write_bytes(raw)
im=nib.as_closest_canonical(nib.load(out/'ixi322-vessels.nii.gz'))
# RAS -> Three.js: right, superior, posterior.
a=(np.asanyarray(im.dataobj)>0).transpose(0,2,1)[:,:,::-1]
spacing=np.asarray(im.header.get_zooms())[[0,2,1]].astype(float)
loc=np.argwhere(a);lo=np.maximum(loc.min(0)-4,0);hi=np.minimum(loc.max(0)+5,a.shape)
a=a[tuple(slice(l,h) for l,h in zip(lo,hi))]
# Quantized scalar field is shared by meshing, routes and camera containment.
field=np.round(ndi.gaussian_filter(a.astype(np.float32),.5)*255).astype(np.uint8)
inside=field>127.5
labels,n=ndi.label(inside,np.ones((3,3,3)));counts=np.bincount(labels.ravel());counts[0]=0
component=labels==counts.argmax()
depth=ndi.distance_transform_edt(component,sampling=spacing)
origin=-(np.array(a.shape)-1)*spacing/2
sample=lambda pts: ndi.map_coordinates(field.astype(np.float32),np.asarray(pts).T,order=1,mode='constant',cval=0,prefilter=False)
# Skeletonize the largest connected region and reject corner links outside the surface.
coords=np.argwhere(skeletonize(component));lookup={tuple(p):i for i,p in enumerate(coords)}
adj=[[] for p in coords]
deltas=[np.array([x,y,z]) for x in [-1,0,1] for y in [-1,0,1] for z in [-1,0,1] if x or y or z]
f=field.astype(np.float32)
for i,p in enumerate(coords):
 for d in deltas:
  j=lookup.get(tuple(p+d))
  if j is not None and j>i:
   pts=np.array([p+d*t for t in np.linspace(.05,.95,19)])
   if np.min(ndi.map_coordinates(f,pts.T,order=1,prefilter=False))>150:
    adj[i].append(j);adj[j].append(i)
# Keep the largest routable connected skeleton, without bridging gaps.
seen=set();groups=[]
for i in range(len(coords)):
 if i in seen:continue
 q=[i];seen.add(i)
 for j in q:
  for k in adj[j]:
   if k not in seen:seen.add(k);q.append(k)
 groups.append(q)
keep=set(max(groups,key=len))
# Collapse connected junction voxels into one node, using paths inside each junction.
critical={i for i in keep if len(adj[i])!=2};nodeof={};nodegroups=[];reps=[]
for i in critical:
 if i in nodeof:continue
 group=[i];nodeof[i]=len(nodegroups)
 for j in group:
  for k in adj[j]:
   if k in critical and k not in nodeof:nodeof[k]=len(nodegroups);group.append(k)
 nodegroups.append(group);reps.append(max(group,key=lambda j:depth[tuple(coords[j])]))
def junction_path(node,end):
 start=reps[node];q=deque([start]);parent={start:None}
 while q:
  i=q.popleft()
  if i==end:break
  for j in adj[i]:
   if nodeof.get(j)==node and j not in parent:parent[j]=i;q.append(j)
 route=[end]
 while route[-1]!=start:route.append(parent[route[-1]])
 return route[::-1]
used=set();edges=[]
for ni,group in enumerate(nodegroups):
 for i in group:
  for j in adj[i]:
   if nodeof.get(j)==ni or (i,j) in used:continue
   path=[i,j];used.add((i,j));used.add((j,i))
   while path[-1] not in nodeof:
    options=[k for k in adj[path[-1]] if k!=path[-2]]
    if not options:break
    k=options[0];used.add((path[-1],k));used.add((k,path[-1]));path.append(k)
   if path[-1] not in nodeof:continue
   nj=nodeof[path[-1]]
   if nj==ni:continue
   full=junction_path(ni,i)[:-1]+path+junction_path(nj,path[-1])[::-1][1:]
   p=coords[full].astype(float)
   # Smooth jitter only when the entire replacement remains within the lumen.
   for iteration in range(3):
    proposal=p.copy();proposal[1:-1]=(p[:-2]+2*p[1:-1]+p[2:])/4
    pts=np.concatenate([proposal]+[proposal[:-1]*(1-t)+proposal[1:]*t for t in [.1,.2,.3,.4,.5,.6,.7,.8,.9]])
    if np.min(ndi.map_coordinates(f,pts.T,order=1,prefilter=False))>150:p=proposal
   world=p*spacing+origin
   length=np.linalg.norm(np.diff(world,axis=0),axis=1).sum()
   if length<.01:continue
   radii=ndi.map_coordinates(depth,p.T,order=1,prefilter=False)
   edges.append({'a':ni,'b':nj,'points':np.round(world,5).tolist(),'radius':round(float(np.median(radii)),5)})
# Pick a long, wide trunk and begin in its interior, not at a terminal cap.
degree=np.bincount([node for edge in edges for node in [edge['a'],edge['b']]],minlength=len(reps))
candidates=[i for i,e in enumerate(edges) if degree[e['a']]>2 and degree[e['b']]>2 and np.linalg.norm(np.diff(e['points'],axis=0),axis=1).sum()>5]
start=max(candidates,key=lambda i:edges[i]['radius']**2*min(15,np.linalg.norm(np.diff(edges[i]['points'],axis=0),axis=1).sum()))
network={'nodes':np.round(coords[reps]*spacing+origin,5).tolist(),'edges':edges,'start':{'edge':start,'reverse':False,'progress':.25}}
(out/'ixi322-network.json').write_text(json.dumps(network,separators=(',',':')))
vertices,faces,normals,_=marching_cubes(field.astype(np.float32),127.5,spacing=spacing,allow_degenerate=False)
vertices+=origin
# Let Three.js recompute normals from the actual vertex winding.
mesh=struct.pack('<II',len(vertices),len(faces)*3)+vertices.astype('<f4').tobytes()+faces.astype('<u4').tobytes()
(out/'ixi322-surface.bin').write_bytes(mesh)
(out/'ixi322-field.gz').write_bytes(gzip.compress(field.tobytes(order='F'),mtime=0))
meta={'subject':name,'source':'https://github.com/zbizjak/IXI-vascular-segmentation-Dataset/tree/8f5f632fd0567e8770b09acd9057bdbb1a2ac6b9','license':'CC-BY-NC-SA-4.0','licenseUrl':'https://creativecommons.org/licenses/by-nc-sa/4.0/','sourceSha256':hashlib.sha256(raw).hexdigest(),'shape':list(a.shape),'scale':spacing.tolist(),'origin':origin.tolist(),'foregroundVoxels':int(a.sum()),'routableSkeletonVoxels':len(keep),'surfaceTriangles':len(faces),'branches':len(edges),'processing':'RAS reorientation; foreground crop; Gaussian sigma 0.5 voxel; uint8 field; isosurface at 127.5; largest-component skeleton; in-lumen smoothing. No vessel dilation or synthetic connections.'}
# Convert numpy scalars for JSON.
(out/'ixi322.json').write_text(json.dumps(meta,indent=2,default=int)+'\n')
print(json.dumps(meta,default=int));print('Asset bytes',sum(p.stat().st_size for p in out.glob('ixi322*')))

# Validate the camera route against the exact triangle surface as a final stage.
import subprocess
subprocess.run(["node", str(Path(__file__).with_name("prepare-camera-routes.mjs"))], check=True)
