#!/usr/bin/env python3
"""Judge round hull-area-1 on its recording, as hull-area-predictions.md fixes.

Usage:
  hull_area_report.py discovery RECORDING DECISION_JSON
  hull_area_report.py heldout RECORDING DECISION_JSON REPORT_JSON
  hull_area_report.py check RECORDING
RECORDING holds one directory per host, each record_geometry(..., 'hull-area')
output. `discovery` checks the frozen predictions digests, judges every model on
the discovery sets and grids of each host and writes the models supported on
every AMD host. `heldout` judges only those models, on the held-out and fresh
sets and grids (the addendum's). Only AMD hosts decide; others are reported.
`check` runs both on the pinned recording (hull-area-reference.json) and fails
unless they reach the round's recorded outcome.
"""
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

import hull_area_design as design

HERE = Path(__file__).resolve().parent
# The round's outcome on dispatch 2 (hull-area-predictions.md, "Results").
OUTCOME = ['K', 'L0']
# Each inputs file and its frozen predictions digest (hull-area-predictions.md).
FROZEN = {'hull-area-inputs.json': '14ec8549270429828f78c0c47276000d6b13237772553814d5bfdc481c06f567',
          'hull-area-inputs-2.json': '3a0966d7a1c9df424a2d16db9b0f6f77252d7e9fa514aa760f0542bb6a81c9d4'}
CONDITIONAL = ('A1k', 'A2k', 'A3k', 'A4k', 'A5k', 'T1', 'T2', 'T3', 'T4', 'T5')


def array(root, descriptor, columns):
    """A recorded MATLAB double matrix as a list of rows."""
    assert descriptor['class'] == 'double' and descriptor['imaginary'] == '', descriptor
    rows, width = descriptor['shape']
    assert width == columns, descriptor
    data = (root / descriptor['file']).read_bytes()
    assert len(data) == 8 * rows * width, descriptor['file']
    values = struct.unpack(f'<{rows * width}d', data)
    return [tuple(values[c * rows + r] for c in range(width)) for r in range(rows)]


def hosts(recording):
    """Each host's directory and whether its CPU is AMD (lscpu's model name)."""
    out = []
    for root in sorted(p for p in recording.iterdir() if (p / 'geometry.json').is_file()):
        environment = json.loads((root / 'environment.json').read_text())
        assert environment.get('mode') == 'hull-area', root
        model = re.search(r'Model name:\s+([^\n\\]+)', json.dumps(environment['cpu']))
        out.append((root, model.group(1).strip() if model else 'unknown'))
    return out


def area_models(points, k, triangles, corner_points, corner_k, corner_triangles):
    """Every conditional model's AV and corners AV from what MATLAB recorded."""
    out = {}
    for m in ('A1', 'A2', 'A3', 'A4', 'A5'):
        out[m + 'k'] = (design.areas(points, k)[m], design.areas(corner_points, corner_k)[m])
    for m in ('T1', 'T2', 'T3', 'T4', 'T5'):
        out[m] = (design.triangle_areas(points, triangles, m), design.triangle_areas(corner_points, corner_triangles, m))
    return out


def judge(recording, roles, models):
    frozen = {'sets': {}, 'linspace': {}}
    spec, grids = {}, {}
    for name, expected in FROZEN.items():
        inputs = json.loads((HERE / name).read_text())
        predicted = design.predictions(inputs)
        if design.digest(predicted) != expected:
            raise SystemExit(f'{name} no longer gives its frozen predictions')
        frozen['sets'].update(predicted['sets'])
        frozen['linspace'].update(predicted['linspace'])
        spec.update({s['identity']: (inputs, s) for s in inputs['sets']})
        grids.update({g['identity']: g for g in inputs['linspace']})
    report = {'roles': sorted(roles), 'hosts': {}}
    for root, cpu in hosts(recording):
        listing = json.loads((root / 'geometry.json').read_text())
        failures = {m: [] for m in models}
        counted = {'sets': 0, 'grids': 0}
        notes = {'polyareaEqualsAV': 0, 'pointsAsSent': 0}
        for case in listing['cases']:
            if case['kind'] == 'hull-area':
                identity = case['id'][len('area_'):]
                inputs, entry = spec[identity]
                if entry['role'] not in roles:
                    continue
                counted['sets'] += 1
                assert case['error'] == '', case['id']
                sent = design.decoded_points(inputs, entry)
                points = array(root, case['dtPoints'], 2)
                notes['pointsAsSent'] += [tuple(map(design.bits, p)) for p in array(root, case['points'], 2)] == [tuple(map(design.bits, p)) for p in sent]
                assert [tuple(map(design.bits, p)) for p in points] == [tuple(map(design.bits, p)) for p in sent], f'{identity}: Dt.Points differs from the input'
                k = [int(v[0]) for v in array(root, case['hull'], 1)]
                corner_k = [int(v[0]) for v in array(root, case['cornersHull'], 1)]
                av = array(root, case['area'], 1)[0][0]
                corners_av = array(root, case['cornersArea'], 1)[0][0]
                notes['polyareaEqualsAV'] += design.bits(array(root, case['polyarea'], 1)[0][0]) == design.bits(av)
                triangles = array(root, case['triangles'], 3)
                corner_points = [points[i - 1] for i in k[:-1]]
                corner_triangles = array(root, case['cornersTriangles'], 3)
                predicted = frozen['sets'][identity]
                observed = (design.hexed(av), design.hexed(corners_av))
                conditional = area_models(points, k, triangles, corner_points, corner_k, corner_triangles) if any(m in CONDITIONAL for m in models) else {}
                for m in models:
                    if m == 'K':
                        ok = (hashlib.sha256(json.dumps(k).encode()).hexdigest() == predicted['hullSha256']
                              and hashlib.sha256(json.dumps(corner_k).encode()).hexdigest() == predicted['cornersHullSha256'])
                    elif m in design.AREA_MODELS:
                        ok = (predicted['areas'][m], predicted['cornersAreas'][m]) == observed
                    elif m in CONDITIONAL:
                        ok = tuple(design.hexed(v) for v in conditional[m]) == observed
                    else:
                        continue
                    if not ok:
                        failures[m].append(identity)
            elif case['kind'] == 'linspace':
                identity = case['id'][len('linspace_'):]
                if grids[identity]['role'] not in roles:
                    continue
                counted['grids'] += 1
                values = [v for row in array(root, case['values'], case['values']['shape'][1]) for v in row]
                digest = hashlib.sha256(''.join(design.hexed(v) for v in values).encode()).hexdigest()
                for m in models:
                    if m in design.GRID_MODELS and frozen['linspace'][identity][m] != digest:
                        failures[m].append(identity)
        report['hosts'][root.name] = {'cpu': cpu, 'amd': cpu.upper().startswith('AMD'), **counted, **notes,
                                      'failures': {m: len(v) for m, v in failures.items()},
                                      'firstFailures': {m: v[:5] for m, v in failures.items() if v}}
    amd = [h for h in report['hosts'].values() if h['amd']]
    # Only AMD recordings decide; another host's results are reported beside them.
    report['decides'] = bool(amd)
    report['supported'] = [m for m in models if all(h['failures'][m] == 0 for h in amd)] if amd else []
    return report


def main(arguments):
    if len(arguments) == 3 and arguments[0] == 'discovery':
        models = ['K', *design.AREA_MODELS, *CONDITIONAL, *design.GRID_MODELS]
        report = judge(Path(arguments[1]), {'discovery'}, models)
        Path(arguments[2]).write_text(json.dumps(report, indent=1) + '\n')
    elif len(arguments) == 4 and arguments[0] == 'heldout':
        decision = json.loads(Path(arguments[2]).read_text())
        report = judge(Path(arguments[1]), {'heldout', 'fresh'}, decision['supported'])
        report['discoveryDecisionSha256'] = hashlib.sha256(Path(arguments[2]).read_bytes()).hexdigest()
        Path(arguments[3]).write_text(json.dumps(report, indent=1) + '\n')
    elif len(arguments) == 2 and arguments[0] == 'check':
        recording = Path(arguments[1])
        discovery = judge(recording, {'discovery'}, ['K', *design.AREA_MODELS, *CONDITIONAL, *design.GRID_MODELS])
        report = judge(recording, {'heldout', 'fresh'}, discovery['supported'])
        counts = {h: (v['sets'], v['grids']) for h, v in report['hosts'].items()}
        if not discovery['decides'] or discovery['supported'] != OUTCOME or report['supported'] != OUTCOME:
            raise SystemExit(f"outcome changed: discovery {discovery['supported']}, held out {report['supported']}")
        if any(c != (300, 132) for c in counts.values()) or any(sum(v['failures'].values()) for v in report['hosts'].values()):
            raise SystemExit(f'held-out inventory or failures changed: {counts}')
        print(f'Round hull-area-1: {OUTCOME} supported on {len(report["hosts"])} hosts; every area model refuted on discovery.')
        return
    else:
        raise SystemExit(__doc__)
    print(json.dumps({h: {k: v[k] for k in ('cpu', 'sets', 'grids', 'failures')} for h, v in report['hosts'].items()}, indent=1))
    print('supported:', report['supported'] if report['decides'] else 'nothing: no AMD host')


if __name__ == '__main__':
    main(sys.argv[1:])
