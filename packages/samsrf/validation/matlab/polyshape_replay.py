"""Replays recorded resolved polyshape boundaries through the native model (#732).

KeepCollinearPoints output is a separate MATLAB configuration, not an internal
checkpoint of the default polyshape. For each polygon of a polyshape-causal
recording this reports MATLAB-only correspondences (viaSimplify, fromDefault and
fromKept against the default) and whether the model, run on the recorded P,
KeepCollinearPoints and default boundaries, reproduces the corresponding MATLAB
output: vertex sets, unoriented rings and new (non-source) vertices.

  polyshape_stages --replay points|collinearVertices|simplified HOST CASE rp_FIELD_CASE.json
  python3 polyshape_replay.py HOST_DIR STAGES_DIR
"""
import json, math, os, sys, collections
import numpy as np
ROOT, OUTDIR = sys.argv[1], sys.argv[2]
rec = json.load(open(os.path.join(ROOT, 'geometry.json')))

def read(desc):
    a = np.fromfile(os.path.join(ROOT, desc['file']), dtype='<f8')
    sh = desc['shape']
    return a.reshape(sh[::-1]).T if len(sh) == 2 else a

def split(rows, counts):
    out, o = [], 0
    for n in counts.ravel().astype(int):
        n = max(n, 0); out.append(rows[o:o + n]); o += n
    assert o == len(rows)
    return out

def rings(rows):
    out, cur = [], []
    for v in rows:
        if np.isnan(v[0]):
            if cur: out.append(cur)
            cur = []
        else:
            cur.append((float(v[0]), float(v[1])))
    if cur: out.append(cur)
    return out

def cyc(R):
    k = R.index(min(R)); return tuple(R[k:] + R[:k])

def unoriented(R):
    return min(cyc(R), cyc(R[::-1]))

def model_rings(stage, source_rows):
    """The model's final rings, in the recording's coordinates."""
    if stage is None: return []
    if 'error' in stage: return None
    c, s = stage['centre'], stage['scale']
    original = {}
    for v in source_rows:
        if np.isnan(v[0]): continue
        p = (float(v[0]), float(v[1]))
        original.setdefault((math.trunc((p[0] - c[0]) * s), math.trunc((p[1] - c[1]) * s)), p)
    inv = 1.0 / s
    to = lambda k: original.get(tuple(k), (k[0] * inv + c[0], k[1] * inv + c[1]))
    return [[to(k) for k in R] for R in stage['secondClean']]

summary = {}
for case in rec['cases']:
    cid = case['id']
    P = split(read(case['points']), read(case['counts']))
    default = split(read(case['simplified']), read(case['simplifiedCounts']))
    kept = split(read(case['collinearVertices']), read(case['collinearCounts']))
    from_kept = split(read(case['fromKept']), read(case['fromKeptCounts']))
    from_default = split(read(case['fromDefault']), read(case['fromDefaultCounts']))
    via = split(read(case['viaSimplify']), read(case['viaSimplifyCounts']))
    st = {f: json.load(open(os.path.join(OUTDIR, f'rp_{f}_{cid}.json'))) for f in ('points', 'simplified', 'collinearVertices')}
    stats = collections.Counter()
    per = []
    for i in range(len(P)):
        D = rings(default[i]); K = rings(kept[i]); FK = rings(from_kept[i]); FD = rings(from_default[i]); V = rings(via[i])
        sset = lambda rs: set(p for r in rs for p in r)
        uring = lambda rs: collections.Counter(map(unoriented, rs))
        row = {'case': i}
        # MATLAB-only empirical correspondences.
        row['matlab viaSimplify = default'] = sset(V) == sset(D) and uring(V) == uring(D)
        row['matlab fromDefault = default'] = sset(FD) == sset(D) and uring(FD) == uring(D)
        row['matlab fromKept = default (vertices)'] = sset(FK) == sset(D)
        row['matlab fromKept = default (rings)'] = uring(FK) == uring(D)
        row['matlab kept vertices include default'] = sset(D) <= sset(K)
        # Model replays against their recorded outputs.
        for name, field, src_rows, target in (('model(P) vs default', 'points', P[i], D),
                                              ('model(kept) vs fromKept', 'collinearVertices', kept[i], FK),
                                              ('model(default) vs fromDefault', 'simplified', default[i], FD)):
            M = model_rings(st[field][i], src_rows)
            if M is None:
                row[name + ' (vertices)'] = row[name + ' (rings)'] = 'error'; continue
            row[name + ' (vertices)'] = sset(M) == sset(target)
            row[name + ' (rings)'] = uring(M) == uring(target)
            src = set((float(v[0]), float(v[1])) for v in src_rows if not np.isnan(v[0]))
            new_target = sset(target) - src
            new_model = sset(M) - src
            row[name + ' new vertices equal'] = new_target == new_model
        for k, v in row.items():
            if k != 'case': stats[(k, v)] += 1
        per.append(row)
    summary[cid] = {'polygons': len(P), 'counts': {f'{k} = {v}': n for (k, v), n in sorted(stats.items(), key=str)}, 'rows': per}
json.dump(summary, open(os.path.join(OUTDIR, 'replay-report.json'), 'w'), indent=0)
for cid, s in summary.items():
    print('==', cid, s['polygons'])
    for k, n in s['counts'].items(): print('  ', k, n)
