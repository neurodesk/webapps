#!/usr/bin/env python3
"""RESEARCH ONLY. Value-by-value accounting of the 24-run CLI matrix (run.sh outputs) for the
committed module and the Intel research module, against both hosts' MATLAB processes.

Each MATLAB value is held bitwise, as compare_web_cli.py holds it and with its readers:
every Srf.Data value over the ROI (real and imaginary parts, the engine's value cast to
MATLAB's class, which must be exact) and every exported GIfTI value over every vertex. A
value is equal only if the cast is exact and the bits agree (NaN payloads and the sign of
zero included). For the research module each value moves between the committed module's
result and its own: kept (equal in both), gained, lost, or still differing. No tolerance.

Every value is labelled by the route of its final value (vertices are zero-based):

- `real-double`: a double vertex with no imaginary part on any side. The research module
  computes it with the samsrf-mkl-avx512 kernels wherever the arithmetic is real; this
  label does not establish that every kernel on its path is identified (the coarse fit's
  correlations, for example, are not modelled on either host).
- `complex-double`: a vertex whose Srf.Data has an imaginary part on any side (the SamSrf
  CSS convention). Complex least squares stays shipped. The original `avx512` variant
  replaces only the real y norm inside complex corr; `avx512-real-corr` keeps that corr
  shipped; `avx512-complex-corr` also installs the complex dot and norm candidates. None
  identifies the whole complex route. Its fit may evaluate real predictions on the way.
- `single`: single data, whose kernels have no Intel reference and stay the shipped ones.
- `outside-roi`: GIfTI values outside the ROI, which no kernel computes.

Refused and unsupported runs carry no values; they are listed with the comparator's class.

Before any value is counted (fail closed):

- every comparator report exists and has no failed or inventory-error run, and names the
  module the run was meant to use (SHA-256 of samsrf_wasm_bg.wasm);
- null control: the hooks build (nothing installed) writes the committed module's bytes in
  every file of every run on both bundles, with the same statuses and messages;
- the two hosts' bundles differ only in MAT/HDF5 headers, so each module must write the
  same bytes from both; it is checked, not assumed;
- host roles come from the MATLAB receipts the comparator read, not from folder names: the
  root's process must report MKL's CNR `auto` branch on an AMD CPU and ubuntu-24.04's the
  `AVX512_E1` branch.

The MATLAB executions are the source recording's processes (`source-1`), whose receipts do
not attest the bundle (the comparator's --allow-unattested-source-inputs). Nothing here is
compiled-image (container) or browser UI evidence.

The full report (--out) lists every lost value on both hosts. The summary (--summary) keeps
every count, every lost value on the Intel host (the research module's own reference), the
AMD losses counted per run, map and kind (the research module is not the AMD reference), the
SHA-256 of every output and of the full report.

Usage: account.py --pins CLI_PINS --shipped RUNS --control RUNS --control-build BUILD_JSON
                  --research RUNS --research-build BUILD_JSON --committed WASM
                  --out REPORT_JSON --summary SUMMARY_JSON
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy

MATLAB_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(MATLAB_DIR))
from compare_cli import expected_results, read_mat  # noqa: E402
from compare_web_cli import matlab_results, surface_map, web_files  # noqa: E402

HOSTS = {'amd': '', 'intel': 'ubuntu-24.04'}
KINDS = ('real', 'imaginary', 'gifti')
OUTCOMES = ('kept', 'gained', 'lost', 'neither')


class Refused(SystemExit):
    pass


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


BRANCHES = {'amd': ('AMD', '(CNR branch auto)'), 'intel': ('', '(CNR branch AVX512_E1)')}


def check_report(report, module_sha, label, host):
    identity = report['matlab']
    cpu_prefix, branch = BRANCHES[host]
    if identity.get('kind') != 'source' or not str(identity.get('blas', '')).endswith(branch) \
            or not str(identity.get('cpu', '')).upper().startswith(cpu_prefix.upper()):
        raise Refused(f'{label} {host}: the receipts report {identity.get("cpu")!r} {identity.get("blas")!r}, not this role')
    summary = report['summary']
    if summary['failedRuns'] or summary['inventory-errorRuns']:
        raise Refused(f'{label} {host}: failed or inventory-error runs')
    if report['web']['wasmSha256'] != module_sha:
        raise Refused(f'{label} {host}: the web run used another module')


def run_files(web_root, run_id):
    """Every file a run wrote, by name, with its bytes; the record and its status."""
    record = read_json(web_root / f'{run_id}.web.json')
    directory = web_root / run_id
    files = {path.name: path.read_bytes() for path in sorted(directory.iterdir())} if directory.is_dir() else {}
    return record, files


def same_outputs(a_root, b_root, plan):
    """Statuses, messages and every written file's bytes are equal between two web runs."""
    differences, files = [], 0
    for run in plan['runs']:
        (a, a_files), (b, b_files) = run_files(a_root, run['id']), run_files(b_root, run['id'])
        if (a['status'], a.get('message')) != (b['status'], b.get('message')):
            differences.append(f'{run["id"]}: status or message')
        if a_files != b_files:
            differences.append(f'{run["id"]}: {sorted(n for n in set(a_files) | set(b_files) if a_files.get(n) != b_files.get(n))}')
        files += len(a_files)
    return differences, files


def equal_values(matlab, web):
    """Per value: the engine's value cast to MATLAB's class (as compare_web_cli.py casts
    Srf.Data; GIfTIs are float32 on both sides) is exact and bitwise equal."""
    cast = web.astype(matlab.dtype)
    width = f'u{web.dtype.itemsize}'
    exact_cast = (cast.astype(web.dtype).view(width) == web.view(width)) | (numpy.isnan(cast) & numpy.isnan(web))
    size = matlab.dtype.itemsize
    bits = matlab.view(f'u{size}') == cast.view(f'u{size}')
    return exact_cast & bits


def hex_value(value):
    return value.tobytes()[::-1].hex()


def module_arrays(run, web_root, matlab_dir):
    """The run's Srf.Data parts over the ROI and its GIfTIs, as compare_web_cli.py reads them."""
    mat, labels, maps = expected_results(run)
    record = read_json(web_root / f'{run["id"]}.web.json')
    _, _, rows, imaginary_rows = web_files(run, record, web_root / run['id'])
    entries = {key: (kind, values) for key, kind, values in read_mat(matlab_dir / mat)}
    data, imaginary, roi, vertices = matlab_results(entries, run['precision'], labels)
    if imaginary is None:
        imaginary = numpy.zeros_like(data)
    web = {
        'real': rows[:, roi].T,
        'imaginary': imaginary_rows[:, roi].T,
        'gifti': numpy.stack([surface_map(web_root / run['id'] / name, vertices) for name in maps], axis=1),
    }
    matlab = {
        'real': data,
        'imaginary': imaginary,
        'gifti': numpy.stack([surface_map(matlab_dir / name, vertices) for name in maps], axis=1),
    }
    return labels, maps, roi, vertices, matlab, web


def routes(run, roi, vertices, imaginary_parts):
    """Each Srf.Data row's route and each GIfTI vertex's."""
    if run['precision'] == 'single':
        row_route = numpy.full(len(roi), 'single', dtype=object)
    else:
        complex_rows = numpy.zeros(len(roi), dtype=bool)
        for parts in imaginary_parts:
            complex_rows |= numpy.any(parts != 0, axis=1)
        row_route = numpy.where(complex_rows, 'complex-double', 'real-double').astype(object)
    vertex_route = numpy.full(vertices, 'outside-roi', dtype=object)
    vertex_route[roi] = row_route
    return row_route, vertex_route


def account_host(plan, pins_root, shipped_root, research_root, shipped_report, research_report):
    shipped_class = {run['id']: run for run in shipped_report['runs']}
    research_class = {run['id']: run for run in research_report['runs']}
    runs, losses, totals = [], [], {}
    for run in plan['runs']:
        rid = run['id']
        entry = {'id': rid, 'precision': run['precision'], 'algorithm': run['algorithm'],
                 'class': {'shipped': shipped_class[rid]['class'], 'research': research_class[rid]['class']}}
        if entry['class']['shipped'] in ('refused', 'unsupported') or entry['class']['research'] in ('refused', 'unsupported'):
            if entry['class']['shipped'] != entry['class']['research']:
                raise Refused(f'{rid}: the modules end the run differently')
            entry['route'] = entry['class']['shipped']
            entry['message'] = shipped_class[rid].get('message')
            runs.append(entry)
            continue
        matlab_dir = pins_root / 'source-1' / rid
        labels, maps, roi, vertices, matlab, shipped = module_arrays(run, shipped_root, matlab_dir)
        _, _, _, _, _, research = module_arrays(run, research_root, matlab_dir)
        row_route, vertex_route = routes(run, roi, vertices,
                                         [matlab['imaginary'], shipped['imaginary'], research['imaginary']])
        entry['routes'] = {route: int(numpy.count_nonzero(row_route == route)) for route in sorted(set(row_route))}
        entry['maps'] = []
        for index, (label, name) in enumerate(zip(labels, maps)):
            map_entry = {'label': label, 'file': name}
            for kind in KINDS:
                reference = numpy.ascontiguousarray(matlab[kind][:, index])
                before = equal_values(reference, numpy.ascontiguousarray(shipped[kind][:, index]))
                after = equal_values(reference, numpy.ascontiguousarray(research[kind][:, index]))
                route_of = vertex_route if kind == 'gifti' else row_route
                counts = {}
                for route in sorted(set(route_of)):
                    mask = route_of == route
                    counts[route] = {
                        'values': int(numpy.count_nonzero(mask)),
                        'kept': int(numpy.count_nonzero(mask & before & after)),
                        'gained': int(numpy.count_nonzero(mask & ~before & after)),
                        'lost': int(numpy.count_nonzero(mask & before & ~after)),
                        'neither': int(numpy.count_nonzero(mask & ~before & ~after)),
                    }
                    bucket = totals.setdefault(kind, {}).setdefault(route, dict.fromkeys(('values', *OUTCOMES), 0))
                    for key, value in counts[route].items():
                        bucket[key] += value
                map_entry[kind] = counts
                for position in numpy.flatnonzero(before & ~after):
                    vertex = int(roi[position]) if kind != 'gifti' else int(position)
                    losses.append({'run': rid, 'map': label, 'kind': kind, 'vertex0': vertex,
                                   'route': str(route_of[position]),
                                   'matlab': hex_value(reference[position]),
                                   'shipped': hex_value(numpy.ascontiguousarray(shipped[kind][:, index]).astype(reference.dtype)[position]),
                                   'research': hex_value(numpy.ascontiguousarray(research[kind][:, index]).astype(reference.dtype)[position])})
            entry['maps'].append(map_entry)
        runs.append(entry)
    summary = {
        'runs': {name: {cls: sum(r['class'][name] == cls for r in runs) for cls in ('exact', 'differs', 'refused', 'unsupported')}
                 for name in ('shipped', 'research')},
        'exactMaps': {'shipped': shipped_report['summary']['exactMaps'], 'research': research_report['summary']['exactMaps'],
                      'of': shipped_report['summary']['maps']},
        'values': totals,
    }
    return {'summary': summary, 'runs': runs, 'losses': losses}


def summarise(report, plan, roots, research_build, report_sha):
    """The committed form of the report: counts as [values, kept, gained, lost, neither]."""
    def compact(counts):
        return {route: [c['values'], c['kept'], c['gained'], c['lost'], c['neither']] for route, c in counts.items()}

    outputs = {}
    for label in ('shipped', 'research'):
        for host in HOSTS:
            runs = read_json(roots[label] / f'{host}-web' / 'runs.json')
            outputs.setdefault(label, {})[host] = {run['id']: run.get('mapsSha256', run['status']) for run in runs}
    hosts = {}
    for host, result in report['hosts'].items():
        runs = []
        for run in result['runs']:
            entry = {key: run[key] for key in ('id', 'precision', 'algorithm', 'class')}
            if 'maps' in run:
                entry['routes'] = run['routes']
                entry['maps'] = {m['label']: {kind: compact(m[kind]) for kind in KINDS} for m in run['maps']}
            else:
                entry['message'] = run['message']
            runs.append(entry)
        losses = result['losses']
        if host != 'intel':
            counted = {}
            for loss in losses:
                key = f"{loss['run']} {loss['map']} {loss['kind']}"
                counted[key] = counted.get(key, 0) + 1
            losses = counted
        hosts[host] = {'matlab': {key: result['matlab'][key] for key in ('kind', 'cpu', 'blas')},
                       'summary': {**result['summary'], 'values': {kind: compact(by_route) for kind, by_route in result['summary']['values'].items()}},
                       'runs': runs, 'losses': losses}
    return {
        'counts': '[values, kept, gained, lost, neither]: equal to MATLAB with both modules, only the research '
                  'module, only the committed module, or neither',
        'modules': report['modules'],
        'researchReference': report['researchReference'],
        'patches': research_build['patches'],
        'checks': report['checks'],
        'outputs': outputs,
        'fullReportSha256': report_sha,
        'hosts': hosts,
    }


def summary_text(summary):
    """JSON with one line per top-level entry and per run, so a change shows as a one-run diff."""
    line = lambda value: json.dumps(value, separators=(',', ':'))
    lines = ['{']
    for i, (key, value) in enumerate(summary.items()):
        tail = ',' if i < len(summary) - 1 else ''
        if key != 'hosts':
            lines.append(f' {line(key)}: {line(value)}{tail}')
            continue
        lines.append(' "hosts": {')
        for j, (host, entry) in enumerate(value.items()):
            lines.append(f'  {line(host)}: {{')
            for k, (field, content) in enumerate(entry.items()):
                comma = ',' if k < len(entry) - 1 else ''
                if field == 'runs':
                    lines.append('   "runs": [')
                    lines.extend(f'    {line(run)}' + (',' if r < len(content) - 1 else '') for r, run in enumerate(content))
                    lines.append(f'   ]{comma}')
                else:
                    lines.append(f'   {line(field)}: {line(content)}{comma}')
            lines.append('  }' + (',' if j < len(value) - 1 else ''))
        lines.append(' }' + tail)
    lines.append('}')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    for name in ('pins', 'shipped', 'control', 'control-build', 'research', 'research-build', 'committed', 'out', 'summary'):
        parser.add_argument(f'--{name}', required=True)
    options = parser.parse_args()
    pins = Path(options.pins)
    plan = read_json(pins / 'plan.json')
    if (pins / 'plan.json').read_bytes() != (pins / HOSTS['intel'] / 'plan.json').read_bytes():
        raise Refused('the two hosts recorded different plans')
    modules = {'shipped': sha256(options.committed),
               'control': read_json(options.control_build)['module']['samsrf_wasm_bg.wasm'],
               'research': read_json(options.research_build)['module']['samsrf_wasm_bg.wasm']}
    if read_json(options.control_build)['variant'] != 'hooks' or read_json(options.research_build)['variant'] not in ('avx512', 'avx512-real-corr', 'avx512-complex-corr'):
        raise Refused('the build records name other variants')
    roots = {'shipped': Path(options.shipped), 'control': Path(options.control), 'research': Path(options.research)}
    reports = {}
    for label, root in roots.items():
        for host in HOSTS:
            report = read_json(root / f'{host}.json')
            check_report(report, modules[label], label, host)
            reports[label, host] = report
    checks = {'nullControl': {}, 'bundleIndependence': {}}
    for host in HOSTS:
        differences, files = same_outputs(roots['shipped'] / f'{host}-web', roots['control'] / f'{host}-web', plan)
        if differences:
            raise Refused(f'null control: the hooks build differs from the committed module on {host}: {differences}')
        checks['nullControl'][host] = {'filesIdentical': files, 'runs': len(plan['runs'])}
    for label, root in roots.items():
        differences, files = same_outputs(root / 'amd-web', root / 'intel-web', plan)
        if differences:
            raise Refused(f'{label}: the two bundles gave different outputs: {differences}')
        checks['bundleIndependence'][label] = {'filesIdentical': files}
    report = {
        'modules': modules,
        'researchReference': read_json(options.research_build)['arithmeticReference'],
        'checks': checks,
        'hosts': {},
    }
    for host, sub in HOSTS.items():
        pins_root = pins / sub if sub else pins
        report['hosts'][host] = {
            'matlab': reports['shipped', host]['matlab'],
            **account_host(plan, pins_root, roots['shipped'] / f'{host}-web', roots['research'] / f'{host}-web',
                           reports['shipped', host], reports['research', host]),
        }
    with Path(options.out).open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    summary = summarise(report, plan, roots, read_json(options.research_build), sha256(options.out))
    with Path(options.summary).open('x') as output:
        output.write(summary_text(summary))
    for host, result in report['hosts'].items():
        print(host, result['matlab']['cpu'], json.dumps(result['summary']['runs']), json.dumps(result['summary']['exactMaps']))
        for kind, by_route in result['summary']['values'].items():
            for route, counts in by_route.items():
                print(f'  {kind:<9} {route:<14} {json.dumps(counts)}')
        print(f'  lost values: {len(result["losses"])}')


if __name__ == '__main__':
    main()
