#!/usr/bin/env python3
"""Apply the declared execution repairs to an exact SamSrf checkout.

The source reference uses the three REPAIRS. The SamSrfAnalysis CLI reference
(--cli) adds CLI_REPAIRS; the two sets are recorded separately.

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

# Opt-in for the CLI reference and its compiled build only. The subject-HRF file
# route transposes samsrf_doublegamma's column into a row, which the fitting
# loops then treat as one HRF per vertex. Keep the column.
HRF_ROUTE = "samsrf_doublegamma(Model.TR, [fP(1:2) 1 1 fP(3) 0 32])' * fP(4);"
CLI_REPAIRS = tuple(
    (name, HRF_ROUTE, HRF_ROUTE.replace("])' *", "]) *"))
    for name in ('Fitting/samsrf_fit_prf.m', 'Fitting/samsrf_revcor_prf.m'))


def repairs(cli):
    return REPAIRS + CLI_REPAIRS if cli else REPAIRS


def prepare(source, output, cli=False):
    commit = subprocess.check_output(
        ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != SOURCE['commit']:
        raise ValueError(f"Expected SamSrf {SOURCE['commit']}, found {commit}")
    if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain']):
        raise ValueError('Reference source must be a clean checkout')
    changes = []
    for name, before, after in repairs(cli):
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
    record = {**SOURCE, 'files': [item for _, _, item in changes]}
    if cli:
        record['repairSet'] = 'samsrfanalysis-cli'
        record['patches'] = SOURCE['patches'] + [
            'Keep the subject-HRF file route a column, as samsrf_doublegamma returns it']
    (output / 'source.json').write_text(json.dumps(record, indent=2) + '\n')


if __name__ == '__main__':
    arguments = sys.argv[1:]
    cli = arguments[:1] == ['--cli']
    if cli:
        arguments = arguments[1:]
    if len(arguments) != 2:
        raise SystemExit('Usage: prepare.py [--cli] SAMSRF_CHECKOUT OUTPUT_DIRECTORY')
    prepare(Path(arguments[0]).resolve(), Path(arguments[1]).resolve(), cli)
