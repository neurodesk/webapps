"""Build attributed game assets from a published human vessel segmentation.
Requires numpy, scipy, scikit-image and nibabel. No invented vessel geometry.

Run: uv run --with numpy,scipy,scikit-image,nibabel \\
       python scripts/prepare-human-network.py /path/to/segmentation.nii.gz [meshVoxelBudget] [publishedFileName]

The default source is the 140 um whole-brain pial artery segmentation of
Subject 02 from Bollmann et al. (2022), eLife 11:e71186, shared on OSF at
https://doi.org/10.17605/OSF.IO/NR6GC (file arteries_seg_TOF_hm_xpace_140um_
MoCoOn_20200220145234_7_biasCor_noiseCor_VT450_lVT370_VENP10.nii.gz).

Outputs in public/data: brain.json (provenance), brain-network.json (routes),
brain-surface.bin (mesh), brain-context.bin (half-resolution overview mesh of
the remaining components) and brain-field.gz (containment field). The field and
routes cover the largest connected lumen at native resolution; the mesh adds
the next largest components up to a voxel budget so the overview shows the
wider vasculature without exceeding the download budget.
"""
import sys, hashlib, json, gzip, struct, subprocess
from pathlib import Path
from collections import deque
import numpy as np
import nibabel as nib
from scipy import ndimage as ndi
from skimage.morphology import skeletonize
from skimage.measure import marching_cubes

out = Path(__file__).resolve().parents[1] / 'public' / 'data'
source = Path(sys.argv[1])
mesh_budget = int(sys.argv[2]) if len(sys.argv) > 2 else 220000
# The published file name, when converting from a renamed local copy.
source_name = sys.argv[3] if len(sys.argv) > 3 else source.name
raw = source.read_bytes()
im = nib.as_closest_canonical(nib.load(source))
# RAS -> Three.js: right, superior, posterior.
full = (np.asanyarray(im.dataobj) > 0).transpose(0, 2, 1)[:, :, ::-1]
spacing = np.asarray(im.header.get_zooms())[[0, 2, 1]].astype(float)
loc = np.argwhere(full)
lo = np.maximum(loc.min(0) - 4, 0)
hi = np.minimum(loc.max(0) + 5, full.shape)
full = full[tuple(slice(l, h) for l, h in zip(lo, hi))]
origin_full = -(np.array(full.shape) - 1) * spacing / 2
# Quantized scalar field is shared by meshing, routes and camera containment.
labels, count = ndi.label(ndi.gaussian_filter(full.astype(np.float32), .5) > .5, np.ones((3, 3, 3)))
sizes = np.bincount(labels.ravel())
sizes[0] = 0
order = np.argsort(sizes)[::-1]
main = order[0]
# The playable field is the largest component, cropped to its own bounds.
loc = np.argwhere(labels == main)
clo = np.maximum(loc.min(0) - 4, 0)
chi = np.minimum(loc.max(0) + 5, full.shape)
crop = tuple(slice(l, h) for l, h in zip(clo, chi))
a = (labels[crop] == main)
field = np.round(ndi.gaussian_filter(a.astype(np.float32), .5) * 255).astype(np.uint8)
component = field > 127.5
depth = ndi.distance_transform_edt(component, sampling=spacing)
origin = origin_full + clo * spacing
f = field.astype(np.float32)
# Skeletonize the largest connected region and reject corner links outside the surface.
coords = np.argwhere(skeletonize(component))
lookup = {tuple(p): i for i, p in enumerate(coords)}
adj = [[] for p in coords]
deltas = [np.array([x, y, z]) for x in [-1, 0, 1] for y in [-1, 0, 1] for z in [-1, 0, 1] if x or y or z]
for i, p in enumerate(coords):
    for d in deltas:
        j = lookup.get(tuple(p + d))
        if j is not None and j > i:
            pts = np.array([p + d * t for t in np.linspace(.05, .95, 19)])
            if np.min(ndi.map_coordinates(f, pts.T, order=1, prefilter=False)) > 150:
                adj[i].append(j)
                adj[j].append(i)
# Keep the largest routable connected skeleton, without bridging gaps.
seen = set()
groups = []
for i in range(len(coords)):
    if i in seen:
        continue
    q = [i]
    seen.add(i)
    for j in q:
        for k in adj[j]:
            if k not in seen:
                seen.add(k)
                q.append(k)
    groups.append(q)
keep = set(max(groups, key=len))
# Collapse connected junction voxels into one node, using paths inside each junction.
critical = {i for i in keep if len(adj[i]) != 2}
nodeof = {}
nodegroups = []
reps = []
for i in critical:
    if i in nodeof:
        continue
    group = [i]
    nodeof[i] = len(nodegroups)
    for j in group:
        for k in adj[j]:
            if k in critical and k not in nodeof:
                nodeof[k] = len(nodegroups)
                group.append(k)
    nodegroups.append(group)
    reps.append(max(group, key=lambda j: depth[tuple(coords[j])]))


def junction_path(node, end):
    start = reps[node]
    q = deque([start])
    parent = {start: None}
    while q:
        i = q.popleft()
        if i == end:
            break
        for j in adj[i]:
            if nodeof.get(j) == node and j not in parent:
                parent[j] = i
                q.append(j)
    route = [end]
    while route[-1] != start:
        route.append(parent[route[-1]])
    return route[::-1]


used = set()
edges = []
for ni, group in enumerate(nodegroups):
    for i in group:
        for j in adj[i]:
            if nodeof.get(j) == ni or (i, j) in used:
                continue
            path = [i, j]
            used.add((i, j))
            used.add((j, i))
            while path[-1] not in nodeof:
                options = [k for k in adj[path[-1]] if k != path[-2]]
                if not options:
                    break
                k = options[0]
                used.add((path[-1], k))
                used.add((k, path[-1]))
                path.append(k)
            if path[-1] not in nodeof:
                continue
            nj = nodeof[path[-1]]
            if nj == ni:
                continue
            full_path = junction_path(ni, i)[:-1] + path + junction_path(nj, path[-1])[::-1][1:]
            p = coords[full_path].astype(float)
            # Smooth jitter only when the entire replacement remains within the lumen.
            for iteration in range(3):
                proposal = p.copy()
                proposal[1:-1] = (p[:-2] + 2 * p[1:-1] + p[2:]) / 4
                pts = np.concatenate([proposal] + [proposal[:-1] * (1 - t) + proposal[1:] * t for t in [.1, .2, .3, .4, .5, .6, .7, .8, .9]])
                if np.min(ndi.map_coordinates(f, pts.T, order=1, prefilter=False)) > 150:
                    p = proposal
            world = p * spacing + origin
            length = np.linalg.norm(np.diff(world, axis=0), axis=1).sum()
            if length < .01:
                continue
            radii = ndi.map_coordinates(depth, p.T, order=1, prefilter=False)
            edges.append({'a': ni, 'b': nj, 'points': np.round(world, 5).tolist(), 'radius': round(float(np.median(radii)), 5)})
# Pick a long, wide trunk and begin in its interior, not at a terminal cap.
degree = np.bincount([node for edge in edges for node in [edge['a'], edge['b']]], minlength=len(reps))
edge_length = lambda e: np.linalg.norm(np.diff(e['points'], axis=0), axis=1).sum()
candidates = [i for i, e in enumerate(edges) if degree[e['a']] > 2 and degree[e['b']] > 2 and edge_length(e) > 5]
if not candidates:
    candidates = [i for i, e in enumerate(edges) if edge_length(e) > 5] or list(range(len(edges)))
start = max(candidates, key=lambda i: edges[i]['radius'] ** 2 * min(15, edge_length(edges[i])))
network = {'nodes': np.round(coords[reps] * spacing + origin, 5).tolist(), 'edges': edges, 'start': {'edge': start, 'reverse': False, 'progress': .25}}
(out / 'brain-network.json').write_text(json.dumps(network, separators=(',', ':')))
# Mesh the largest components, each within its own bounds, up to a voxel budget.
vertex_chunks = []
face_chunks = []
offset = 0
meshed = 0
included = 0
for label in order:
    if sizes[label] == 0 or (meshed and meshed + sizes[label] > mesh_budget):
        break
    loc = np.argwhere(labels == label)
    blo = np.maximum(loc.min(0) - 3, 0)
    bhi = np.minimum(loc.max(0) + 4, full.shape)
    box = tuple(slice(l, h) for l, h in zip(blo, bhi))
    part = np.round(ndi.gaussian_filter((labels[box] == label).astype(np.float32), .5) * 255).astype(np.float32)
    vertices, faces, normals, _ = marching_cubes(part, 127.5, spacing=spacing, allow_degenerate=False)
    vertex_chunks.append(vertices + origin_full + blo * spacing)
    face_chunks.append(faces + offset)
    offset += len(vertices)
    meshed += int(sizes[label])
    included += 1
vertices = np.concatenate(vertex_chunks)
faces = np.concatenate(face_chunks)
# Let Three.js recompute normals from the actual vertex winding.
def pack(vertices, faces):
    return struct.pack('<II', len(vertices), len(faces) * 3) + vertices.astype('<f4').tobytes() + faces.astype('<u4').tobytes()
(out / 'brain-surface.bin').write_bytes(pack(vertices, faces))
# Every other component at half resolution, for the overview only. It is never
# part of the playable field or the collision surface.
meshed_labels = order[:included]
rest = full & ~np.isin(labels, meshed_labels)
context_scale = spacing * 2
context = ndi.zoom(ndi.gaussian_filter(rest.astype(np.float32), 1.0), 0.5, order=1)
context_vertices, context_faces, _, _ = marching_cubes(context, 0.2, spacing=context_scale, allow_degenerate=False)
context_vertices += origin_full + (context_scale - spacing) / 2
(out / 'brain-context.bin').write_bytes(pack(context_vertices, context_faces))
(out / 'brain-field.gz').write_bytes(gzip.compress(field.tobytes(order='F'), mtime=0))
meta = {
    'subject': source_name,
    'sourceFile': 'source.nii.gz',
    'dataset': 'Imaging of the Pial Arterial Vasculature (Subject 02, 140 um whole-brain TOF, pial artery segmentation)',
    'source': 'https://doi.org/10.17605/OSF.IO/NR6GC',
    'paper': 'Bollmann S, Mattern H, Bernier M, Robinson SD, Park D, Speck O, Polimeni JR. Imaging of the pial arterial vasculature of the human brain in vivo using high-resolution 7T time-of-flight angiography. eLife 2022;11:e71186.',
    'paperDoi': '10.7554/eLife.71186',
    'license': 'Unspecified on OSF (the eLife article is CC BY 4.0); confirm a data license on the OSF project',
    'licenseUrl': 'https://osf.io/nr6gc/',
    'sourceSha256': hashlib.sha256(raw).hexdigest(),
    'shape': list(a.shape),
    'scale': spacing.tolist(),
    'origin': origin.tolist(),
    'foregroundVoxels': int(full.sum()),
    'playableVoxels': int(a.sum()),
    'components': int(count),
    'meshedComponents': int(included),
    'meshedVoxels': int(meshed),
    'routableSkeletonVoxels': len(keep),
    'surfaceTriangles': int(len(faces)),
    'contextTriangles': int(len(context_faces)),
    'branches': len(edges),
    'processing': 'RAS reorientation; foreground crop; Gaussian sigma 0.5 voxel; uint8 field of the largest connected component at native resolution; isosurface at 127.5 for the largest components within a voxel budget; remaining components as a half-resolution overview-only surface; largest-component skeleton; in-lumen smoothing. No vessel dilation or synthetic connections.',
}
(out / 'brain.json').write_text(json.dumps(meta, indent=2, default=int) + '\n')
print(json.dumps(meta, default=int))
print('Asset bytes', sum(p.stat().st_size for p in out.glob('brain*')))

# Validate the camera route against the exact triangle surface as a final stage.
subprocess.run(["node", str(Path(__file__).with_name("prepare-camera-routes.mjs"))], check=True)
