#!/usr/bin/env python3
import json, sys, itertools
from pathlib import Path
from reflector_probe import cases, eq
from update_probe import dot, leading, MODES
from second_probe import update, UPDATES
if __name__ == '__main__':
    cs = list(cases('ubuntu-22.04-3'))
    results = []
    for um in UPDATES:
        staged = []
        for c in cs:
            v = [1 + 0j] + c['factor'][0][1:]
            w = dot(v, c['y'], ('product', 0, 0), c0last=True)
            q0, t = leading(c['y'][0], w, c['tau'][0], (1, 1))
            tail = [update(z, vi, t, um) for vi, z in zip(v[1:], c['y'][1:])]
            staged.append((c, q0, tail))
        for mode in MODES:
            dots = [dot([1 + 0j] + c['factor'][1][2:], tail, mode, c0last=True) for c, q0, tail in staged]
            for tm in itertools.product(range(3), repeat=2):
                misses = []
                for (c, q0, tail), w in zip(staged, dots):
                    q1, t = leading(tail[0], w, c['tau'][1], tm)
                    if not eq(q1, c['qty'][1]):
                        misses.append(c['id'])
                results.append({'first_update': um, 'second_dot': mode, 'second_temp': tm, 'qty2_equal': len(cs) - len(misses), 'misses': misses})
    results.sort(key=lambda r: r['qty2_equal'], reverse=True)
    Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + '\n')
    for r in results[:12]:
        print(r)
