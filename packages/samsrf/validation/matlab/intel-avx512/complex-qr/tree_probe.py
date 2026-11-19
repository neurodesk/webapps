#!/usr/bin/env python3
import json, sys, struct, collections, importlib.util, functools
from pathlib import Path
spec = importlib.util.spec_from_file_location('lm', Path(__file__).resolve().parents[2] / 'qr-lane-models.py')
lm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lm)
source = (Path(__file__).resolve().parents[2] / 'qr-lane-models.py').read_text()
start = source.index('def lca_sizes(')
end = source.index('\ndef candidates(', start)
source = source[start:end].replace('def lca_sizes(m, layout, lanes, strides, tail):', 'def sizes(m, layout, lanes, block, strides, tail):').replace('len(body) // lanes * lanes', 'len(body) // block * block')
exec(source)
sizes = functools.lru_cache(maxsize=256)(sizes)
from reflector_probe import P
root = P / 'qr-kernels/ubuntu-22.04-3'
meta = json.loads((root / 'kernels.json').read_text())
out = []
for kind in ['probes', 'ormqr']:
    groups = collections.defaultdict(list)
    for p in meta[kind]:
        if p['class'] != 'cdouble' or p['length'] < 3:
            continue
        groups[p['part'], p.get('columns', 1)].append(p)
    for (part, ncols), ps in groups.items():
        recorded = collections.defaultdict(list)
        for p in ps:
            m = p['length']
            data = (root / p['results']['file']).read_bytes()
            fmt = 'h' if p['results']['file'].endswith('.i16') else 'd'
            values = struct.unpack('<' + fmt * (len(data) // (2 if fmt == 'h' else 8)), data)
            columns = p.get('recordedColumns', [0])
            columns = columns if isinstance(columns, list) else [columns]
            for slot, col in enumerate(columns):
                recorded[col].append((m, lm.recorded_sizes(values, m, slot)))
        for col, items in recorded.items():
            candidates = []
            for layout in ['vector'] if kind == 'probes' else ['c0last', 'first']:
                for lanes, block, strides in [(1, 1, ()), (2, 2, (1,)), (2, 8, (1,)), (4, 4, (2, 1)), (4, 8, (2, 1)), (8, 8, (4, 2, 1))]:
                    for tail in ['mod', 'seq']:
                        matches = sum((sizes(m, layout, lanes, block, strides, tail) == expected for m, expected in items))
                        if matches == len(items):
                            candidates.append([layout, lanes, block, strides, tail])
            row = {'kind': kind, 'part': part, 'columns': ncols, 'column': col, 'records': len(items), 'lengths': sorted(set((m for m, _ in items))), 'matching_models': candidates}
            out.append(row)
            print(row, flush=True)
Path(sys.argv[1]).write_text(json.dumps(out, indent=2) + '\n')
