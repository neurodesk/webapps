#!/usr/bin/env python3
"""Apply the three declared execution repairs to an exact SamSrf checkout.

No numerical replacements or Octave shims are installed. Every original and
patched file hash is written to the output so repaired references cannot be
mistaken for results from the unmodified Neurodesk container.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SOURCE = json.loads(Path(__file__).with_name('source.json').read_text())
REPAIRS = (
    ('Surfs/samsrf_32bit_srf.m',
     "if exist('SamSrfDefs.defs_64bit', 'var') && SamSrfDefs.defs_64bit",
     "if isfield(SamSrfDefs, 'def_64bit') && SamSrfDefs.def_64bit"),
    ('Fitting/samsrf_cfparam_loop.m',
     'fSimg = [fSimg; fIimg];',
     'if isempty(FitPrf)\n    fSimg = [fSimg; fIimg];\nend'),
    ('Analysis/samsrf_fit2dprf.m',
     'fminsearch(@(P) errfun(PrfFcn,Mask,Rmap,P), [SeedParams 1 0], OptimOpts)',
     'fminsearch(@(P) errfun(PrfFcn,Mask,Rmap,P), double([SeedParams 1 0]), OptimOpts)'),
)


def prepare(source, output):
    commit = subprocess.check_output(
        ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != SOURCE['commit']:
        raise ValueError(f"Expected SamSrf {SOURCE['commit']}, found {commit}")
    if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain']):
        raise ValueError('Reference source must be a clean checkout')
    changes = []
    for name, before, after in REPAIRS:
        path = source / name
        original = path.read_bytes()
        text = original.decode()
        if text.count(before) != 1:
            raise ValueError(f'Expected exactly one repair site in {name}')
        replacement = text.replace(before, after).encode()
        changes.append((path, replacement, {
            'path': name,
            'originalSha256': hashlib.sha256(original).hexdigest(),
            'patchedSha256': hashlib.sha256(replacement).hexdigest(),
        }))
    output.mkdir(parents=True, exist_ok=True)
    for path, replacement, _ in changes:
        path.write_bytes(replacement)
    (output / 'source.json').write_text(json.dumps({
        **SOURCE, 'files': [record for _, _, record in changes],
    }, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: prepare.py SAMSRF_CHECKOUT OUTPUT_DIRECTORY')
    prepare(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
