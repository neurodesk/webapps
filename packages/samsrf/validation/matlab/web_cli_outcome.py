#!/usr/bin/env python3
"""Freeze or check the outcome of compare_web_cli.py's report, map by map.

The outcome names the MATLAB execution (kind and CPU) and, for every planned run, its
class and, for each contract map, `exact` or the number of values that differ in
Srf.Data, in its imaginary parts and in the GIfTI. `check` fails on any change, better
or worse, so a change to the engine's agreement with MATLAB shows in the diff of the
outcome file that `freeze` rewrites. It applies no tolerance of its own: the counts are
the comparator's bitwise ones.

Usage: web_cli_outcome.py freeze REPORT_JSON OUTCOME_JSON
       web_cli_outcome.py check OUTCOME_JSON REPORT_JSON
"""
import json
from pathlib import Path
import sys


def count(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(f'{name} must be a nonnegative integer count')
    return value


def outcome(report):
    runs = {}
    for run in report['runs']:
        entry = {'class': run['class']}
        if run.get('maps'):
            for item in run['maps']:
                for part in ('srfData', 'imaginary', 'gifti'):
                    comparison = item[part]
                    total = count(comparison['count'], f'{part}.count')
                    differing = count(comparison.get('differing', 0), f'{part}.differing')
                    if differing > total or (comparison['exact'] and differing):
                        raise ValueError(f'{part}.differing contradicts its count or exactness')
            entry['maps'] = {
                item['label']: 'exact' if item['class'] == 'exact' else {
                    part: item[part].get('differing', 0) for part in ('srfData', 'imaginary', 'gifti')}
                for item in run['maps']}
        runs[run['id']] = entry
    matlab = report['matlab']
    return {'matlab': {'kind': matlab['kind'], 'cpu': matlab.get('cpu')},
            'summary': {key: count(report['summary'][key], key) for key in ('exactRuns', 'exactMaps', 'maps')},
            'runs': runs}


def differences(expected, actual, path=''):
    if isinstance(expected, dict) and isinstance(actual, dict):
        found = []
        for key in sorted(set(expected) | set(actual)):
            found += differences(expected.get(key), actual.get(key), f'{path}/{key}')
        return found
    return [] if expected == actual else [f'{path}: expected {json.dumps(expected)}, found {json.dumps(actual)}']


def main(arguments):
    if len(arguments) != 3 or arguments[0] not in ('freeze', 'check'):
        raise SystemExit(__doc__)
    if arguments[0] == 'freeze':
        report, target = (Path(argument) for argument in arguments[1:])
        target.write_text(json.dumps(outcome(json.loads(report.read_text())), indent=1) + '\n')
        return
    expected = json.loads(Path(arguments[1]).read_text())
    found = differences(expected, outcome(json.loads(Path(arguments[2]).read_text())))
    for line in found:
        print(line)
    if found:
        raise SystemExit(f'{len(found)} outcome entries changed; rerun freeze if the change is intended')
    summary = expected['summary']
    print(f'outcome unchanged: {summary["exactRuns"]} exact runs, {summary["exactMaps"]} of {summary["maps"]} maps exact')


if __name__ == '__main__':
    main(sys.argv[1:])
