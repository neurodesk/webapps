#!/usr/bin/env python3
"""Reconstruct MATLAB x'*y summation trees from arithmetic-order FPRev fingerprints."""
import json, os, struct, sys, importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ft', os.path.join(HERE, '..', 'fprev_tree.py'))
ft = importlib.util.module_from_spec(spec); spec.loader.exec_module(ft)

def f64(path):
    b = open(path, 'rb').read(); return list(struct.unpack('<%dd' % (len(b) // 8), b))

def load(pins, host):
    d = os.path.join(pins, 'arithmetic-order', host, 'compatible')
    cases = {c['id']: c for c in json.load(open(os.path.join(d, 'arithmetic-order.json')))['cases'] if c['kind'] == 'dot-order'}
    out = {}
    for c in cases.values():
        n = c['n']
        pairs = f64(os.path.join(d, c['pairs']['file'])); counts = f64(os.path.join(d, c['counts']['file']))
        p = c['pairs']['shape'][0]
        # pairs is p x 2 column-major
        sizes = {}
        for k in range(p):
            a, b = int(pairs[k]) - 1, int(pairs[p + k]) - 1
            sizes[(min(a, b), max(a, b))] = n - int(counts[k])
        out[n] = {'exhaustive': c['exhaustive'], 'sizes': sizes, 'case': c, 'dir': d}
    return out

if __name__ == '__main__':
    pins, host = sys.argv[1], sys.argv[2]
    data = load(pins, host)
    for n in sorted(data):
        if data[n]['exhaustive'] and n >= int(sys.argv[3]) and n <= int(sys.argv[4]):
            print(n, ft.tree_from_sizes(n, data[n]['sizes']))
