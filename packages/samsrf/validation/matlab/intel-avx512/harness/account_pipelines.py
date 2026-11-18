#!/usr/bin/env python3
"""RESEARCH ONLY. Value-by-value accounting of the recorded double CSS pipelines
(css-pipelines-reference.json) for two builds' native runs (native.sh dumps): the baseline
(the hooks build, which runs the shipped arithmetic) and the research build.

Both builds start from each host's own MATLAB courses and noise ceiling, so preprocessing
plays no part: a value that changes between the builds changed through the kernels the
research build replaces. Every map value is held bitwise against MATLAB: the real part
against the recorded maps and the imaginary part against the saved complex Srf.Data (NaN
payloads and the sign of zero included). Each value is then kept (equal with both builds),
gained, lost, or still differing ("neither"). Vertices are labelled from 0. A vertex counts
as complex when MATLAB's saved Srf.Data or either build has an imaginary part in any of its
maps; this labels the final values, not every objective evaluation of the fit. Every gained
and every lost value is listed with its bits and ULP distances; no total hides one.

Host roles come from the recording's own manifest: exactly one host must report MKL's CNR
`auto` branch and one `AVX512_E1`, or the script refuses.

Usage: account_pipelines.py --pins CSS_PIPELINES --baseline DUMP --baseline-build BUILD_JSON
                            --research DUMP --research-build BUILD_JSON --out REPORT_JSON
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

KINDS = ('real', 'imaginary')
OUTCOMES = ('kept', 'gained', 'lost', 'neither')


def read_json(path):
    return json.loads(Path(path).read_text())


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def f64s(path, count):
    data = Path(path).read_bytes()
    if len(data) != 8 * count:
        raise SystemExit(f'{path}: {len(data)} bytes, expected {8 * count}')
    return list(struct.unpack(f'<{count}Q', data))


def ordinal(bits):
    """Integers consecutive in double order (+0 and -0 both 0)."""
    return -(bits & (2**63 - 1)) if bits >> 63 else bits


def ulps(a, b):
    nan = lambda bits: (bits >> 52) & 0x7FF == 0x7FF and bits & (2**52 - 1)
    if nan(a) or nan(b):
        return None
    return abs(ordinal(a) - ordinal(b))


def roles(manifest):
    """{'amd': host, 'intel': host} from the MKL branch each host reports."""
    found = {'amd': [], 'intel': []}
    for host, info in manifest['hosts'].items():
        blas = info['blas']
        if blas.endswith('(CNR branch auto)') and info['cpu'].startswith('AMD'):
            found['amd'].append(host)
        elif blas.endswith('(CNR branch AVX512_E1)'):
            found['intel'].append(host)
        else:
            raise SystemExit(f'{host}: unrecognised MKL branch {blas!r}')
    if len(found['amd']) != 1 or len(found['intel']) != 1:
        raise SystemExit(f'expected one AMD (CNR auto) and one AVX512_E1 host, found {found}')
    return {role: hosts[0] for role, hosts in found.items()}


def read_dump(path):
    values = {}
    lines = Path(path).read_text().splitlines()
    if not lines or lines[0] != 'host\tpipeline\tmap\tvertex0\treal\timaginary':
        raise SystemExit(f'{path}: not a native.sh dump')
    for line in lines[1:]:
        host, pipeline, label, vertex, real, imaginary = line.split('\t')
        key = (host, pipeline, label, int(vertex))
        if key in values:
            raise SystemExit(f'{path}: {key} appears twice')
        values[key] = (int(real, 16), int(imaginary, 16))
    return values


def account(pins, baseline, research):
    manifest = read_json(pins / 'manifest.json')
    hosts = roles(manifest)
    report, expected_keys = {}, set()
    for role, host in hosts.items():
        directory = pins / host / 'compatible'
        recording = read_json(directory / 'pipelines.json')
        cases = {}
        for case in recording['cases']:
            pipeline, labels = case['id'], case['values']
            rows, vertices = case['maps']['shape']
            if rows != len(labels) or case['savedMaps']['shape'] != [rows, vertices]:
                raise SystemExit(f'{host} {pipeline}: map shapes')
            real = f64s(directory / case['maps']['file'], rows * vertices)
            saved = f64s(directory / case['savedMaps']['file'], rows * vertices)
            name = case['savedMaps']['imaginary']
            imaginary = f64s(directory / name, rows * vertices) if name else [0] * (rows * vertices)
            matlab = {'real': lambda r, v: real[v * rows + r], 'imaginary': lambda r, v: imaginary[v * rows + r]}
            keys = [(host, pipeline, label, v) for label in labels for v in range(vertices)]
            expected_keys.update(keys)
            for key in keys:
                if key not in baseline or key not in research:
                    raise SystemExit(f'{key}: missing from a dump')
            complex_vertex = [
                any(imaginary[v * rows + r] & (2**63 - 1) for r in range(rows))
                or any(build[(host, pipeline, label, v)][1] & (2**63 - 1) for build in (baseline, research) for label in labels)
                for v in range(vertices)
            ]
            maps, listed = {}, {'gained': [], 'lost': []}
            for r, label in enumerate(labels):
                counts = {}
                for kind in KINDS:
                    part = 0 if kind == 'real' else 1
                    for v in range(vertices):
                        route = 'complex' if complex_vertex[v] else 'real'
                        expected = matlab[kind](r, v)
                        before = baseline[(host, pipeline, label, v)][part]
                        after = research[(host, pipeline, label, v)][part]
                        outcome = OUTCOMES[0 if before == expected and after == expected else
                                           1 if after == expected else 2 if before == expected else 3]
                        slot = counts.setdefault(f'{kind} {route}', dict.fromkeys(('values', *OUTCOMES), 0))
                        slot['values'] += 1
                        slot[outcome] += 1
                        if outcome in ('gained', 'lost'):
                            listed[outcome].append({'map': label, 'kind': kind, 'vertex0': v, 'route': route,
                                                    'matlab': f'{expected:016x}', 'baseline': f'{before:016x}',
                                                    'research': f'{after:016x}',
                                                    'ulpBaseline': ulps(before, expected), 'ulpResearch': ulps(after, expected)})
                maps[label] = counts
            cases[pipeline] = {'vertices': vertices, 'complexVertices': sum(complex_vertex),
                               'savedRealDiffersFromMaps': sum(a != b for a, b in zip(real, saved)),
                               'maps': maps, **listed}
        report[role] = {'host': host, 'cpu': manifest['hosts'][host]['cpu'], 'blas': manifest['hosts'][host]['blas'], 'pipelines': cases}
    extra = (set(baseline) | set(research)) - expected_keys
    if extra:
        raise SystemExit(f'dump values the recording does not hold: {sorted(extra)[:3]}')
    return report


def totals(report):
    """Per role and kind x route: [values, kept, gained, lost, neither]."""
    out = {}
    for role, entry in report.items():
        sums = {}
        for case in entry['pipelines'].values():
            for counts in case['maps'].values():
                for key, slot in counts.items():
                    total = sums.setdefault(key, [0] * 5)
                    for i, name in enumerate(('values', *OUTCOMES)):
                        total[i] += slot[name]
        out[role] = sums
    return out


def report_text(result):
    """JSON with one line per map and per listed value, so a change shows as a one-line diff."""
    line = lambda value: json.dumps(value, separators=(',', ':'))
    out = ['{']
    keys = list(result)
    for i, key in enumerate(keys):
        tail = ',' if i < len(keys) - 1 else ''
        if key != 'hosts':
            out.append(f' {line(key)}: {line(result[key])}{tail}')
            continue
        out.append(' "hosts": {')
        roles = list(result['hosts'].items())
        for j, (role, entry) in enumerate(roles):
            out.append(f'  {line(role)}: {{')
            out.append(f'   "host": {line(entry["host"])}, "cpu": {line(entry["cpu"])}, "blas": {line(entry["blas"])},')
            out.append('   "pipelines": {')
            pipelines = list(entry['pipelines'].items())
            for k, (pipeline, case) in enumerate(pipelines):
                out.append(f'    {line(pipeline)}: {{')
                scalars = {name: case[name] for name in ('vertices', 'complexVertices', 'savedRealDiffersFromMaps')}
                out.append(f'     {line(scalars)[1:-1]},')
                out.append('     "maps": {')
                maps = list(case['maps'].items())
                out.extend(f'      {line(label)}: {line(counts)}' + (',' if m < len(maps) - 1 else '') for m, (label, counts) in enumerate(maps))
                out.append('     },')
                for name in ('gained', 'lost'):
                    values = case[name]
                    out.append(f'     {line(name)}: [')
                    out.extend(f'      {line(value)}' + (',' if n < len(values) - 1 else '') for n, value in enumerate(values))
                    out.append('     ]' + (',' if name == 'gained' else ''))
                out.append('    }' + (',' if k < len(pipelines) - 1 else ''))
            out.append('   }')
            out.append('  }' + (',' if j < len(roles) - 1 else ''))
        out.append(' }' + tail)
    out.append('}')
    return '\n'.join(out) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    for name in ('pins', 'baseline', 'baseline-build', 'research', 'research-build', 'out'):
        parser.add_argument(f'--{name}', required=True)
    options = parser.parse_args()
    builds = {'baseline': read_json(options.baseline_build), 'research': read_json(options.research_build)}
    if builds['baseline']['variant'] != 'hooks' or builds['research']['variant'] not in ('avx512', 'avx512-real-corr', 'avx512-complex-corr'):
        raise SystemExit('the baseline must be the hooks build and the research an avx512 build')
    report = account(Path(options.pins), read_dump(options.baseline), read_dump(options.research))
    result = {
        'counts': '[values, kept, gained, lost, neither] per kind and vertex route; vertices are zero-based',
        'builds': {label: {'variant': build['variant'], 'patches': build['patches'], 'copied': build.get('copied'),
                           'reference': build['arithmeticReference']} for label, build in builds.items()},
        'dumps': {'baseline': sha256(options.baseline), 'research': sha256(options.research)},
        'totals': totals(report),
        'hosts': report,
    }
    with Path(options.out).open('x') as output:
        output.write(report_text(result))
    for role, sums in result['totals'].items():
        print(role, report[role]['cpu'])
        for key, values in sorted(sums.items()):
            print(f'  {key:<18} {values}')
        for pipeline, case in report[role]['pipelines'].items():
            for loss in case['lost']:
                print(f"  LOST {pipeline} {loss['map']} {loss['kind']} vertex0 {loss['vertex0']} ({loss['route']}): "
                      f"ULP {loss['ulpResearch']} (baseline {loss['ulpBaseline']})")


if __name__ == '__main__':
    main()
