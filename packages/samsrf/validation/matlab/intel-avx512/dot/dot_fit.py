#!/usr/bin/env python3
import sys, os, importlib.util, itertools
HERE = os.path.dirname(os.path.abspath(__file__))
def mod(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + '.py')); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
dt, dm = mod('dot_trees'), mod('dot_models')
pins = sys.argv[1]
intel = dt.load(pins, 'ubuntu-24.04')
amd = dt.load(pins, 'ubuntu-22.04')
lengths = sorted(n for n in intel if n >= 51)
def fits(data, model):
    ok = 0
    for n in lengths:
        sizes = dm.lca_sizes(model(n))
        ok += all(sizes[p] == s for p, s in data[n]['sizes'].items())
    return ok
cands = {}
for lanes in (8, 16, 32, 64):
    powers = [2 ** i for i in range(lanes.bit_length() - 1)]
    orders = set(itertools.permutations(sorted(powers, reverse=True))) if lanes <= 32 else {tuple(sorted(powers, reverse=True))}
    for strides in orders:
        for tail in ('pow2', 'mod', 'halfmask', 'mask'):
            cands[f'L{lanes}/{"-".join(map(str, strides))}/{tail}'] = (lambda L, s, t: (lambda n: dm.build(n, L, s, t)))(lanes, strides, tail)
results = []
for name, model in cands.items():
    results.append((fits(intel, model), name))
results.sort(reverse=True)
print('Intel lengths from 51:', len(lengths))
for score, name in results[:8]:
    print(f'  {score}/{len(lengths)}  {name}')
best = results[0][1]
print('best on AMD (control, expected to fail):', fits(amd, cands[best]))
