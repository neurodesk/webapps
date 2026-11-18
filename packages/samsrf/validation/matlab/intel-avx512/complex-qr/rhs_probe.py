#!/usr/bin/env python3
import json, sys, itertools
from pathlib import Path
from reflector_probe import cases, eq
from update_probe import dot, leading, MODES
from second_probe import update, UPDATES
if __name__ == '__main__':
    cs = list(cases('ubuntu-22.04-3'))
    results = []
    for mode in MODES:
        dots = [dot([1 + 0j] + c['factor'][0][1:], c['y'], mode, c0last=True) for c in cs]
        for tm in itertools.product(range(3), repeat=2):
            misses = [c['id'] for c, w in zip(cs, dots) if not eq(leading(c['y'][0], w, c['tau'][0], tm)[0], c['qty'][0])]
            results.append({'dot': mode, 'temp': tm, 'equal': len(cs) - len(misses), 'misses': misses})
    results.sort(key=lambda r: r['equal'], reverse=True)
    Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + '\n')
    for r in results[:12]:
        print(r)
