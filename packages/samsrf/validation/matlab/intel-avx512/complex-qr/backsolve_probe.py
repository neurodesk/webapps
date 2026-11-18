#!/usr/bin/env python3
import json, sys, itertools, math
from pathlib import Path
from reflector_probe import eq
from multiple_probe import records
from second_probe import update, UPDATES
from solve_probe import div
if __name__ == '__main__':
    rec = list(records())
    results = []
    for dm, um in itertools.product(['direct', 'reciprocal', 'trsv'], UPDATES):
        misses = []
        equal = 0
        for c, a, taus, pivot, ys, qs, bs in rec:
            pivot = list(pivot)
            tol = 10 * len(ys[0]) * sys.float_info.epsilon * abs(a[0][0])
            rank = sum((abs(a[i][i]) > tol for i in range(2)))
            for j, (q, want) in enumerate(zip(qs, bs)):
                x = [0j, 0j]
                if rank == 2:
                    x[1] = div(q[1], a[1][1].real, dm)
                if rank:
                    x[0] = div(update(q[0], a[1][0], x[1], um) if rank == 2 else q[0], a[0][0].real, dm)
                got = [0j, 0j]
                for i, p in enumerate(pivot):
                    got[p] = x[i]
                stored_real = not c['together']['imaginary']
                good = all((eq(v, w) if not stored_real else eq(complex(v.real, 0), complex(w.real, 0)) and v.imag == 0 for v, w in zip(got, want)))
                equal += good
                if not good:
                    misses.append([c['id'], j])
        results.append({'divide': dm, 'update': um, 'equal': equal, 'misses': misses})
    results.sort(key=lambda r: r['equal'], reverse=True)
    Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + '\n')
    for r in results[:5]:
        print(r['divide'], r['update'], r['equal'], r['misses'][:8])
