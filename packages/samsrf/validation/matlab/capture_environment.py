#!/usr/bin/env python3
"""Save only numerical execution requests, before MATLAB can alter its environment."""
import json
import os
from pathlib import Path
import sys


CONTROLS = {
    'MKL_CBWR': 'COMPATIBLE',
    'MKL_NUM_THREADS': '1',
    'OMP_NUM_THREADS': '1',
    'MKL_DYNAMIC': 'FALSE',
    'OMP_DYNAMIC': 'FALSE',
}


def capture(output, environment):
    requested = {key: environment.get(key, '') for key in CONTROLS}
    if requested != CONTROLS:
        raise ValueError('Set the documented BLAS/thread requests before starting MATLAB')
    with (Path(output) / 'environment-request.json').open('x') as receipt:
        json.dump(requested, receipt, indent=2)
        receipt.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: capture_environment.py PREPARED_OUTPUT_DIRECTORY')
    capture(sys.argv[1], os.environ)
