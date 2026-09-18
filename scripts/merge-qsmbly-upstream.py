#!/usr/bin/env python3
"""Prepare three-way QSMbly source merges outside the checkout for review."""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('upstream', type=Path, help='Local clone of astewartau/qsmbly')
parser.add_argument('--base', default='02a4994')
parser.add_argument('--target', default='6e01b15b43b615639881f35e6b1f7dbc214e0864')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = Path(os.environ['TMPDIR']) / 'qsmbly-upstream-merge'
output.mkdir(parents=True, exist_ok=True)

def git(*arguments):
    return subprocess.check_output(['git', '-C', str(args.upstream), *arguments])

renames = {
    'js/controllers/PipelineExecutor.js': 'js/controllers/QsmPipelineController.js',
    'js/controllers/PipelineExecutor.test.js': 'js/controllers/QsmPipelineController.test.js',
}
excluded = {
    '.github/workflows/deploy.yml': 'Monorepo release workflow owns deployment.',
    '.gitignore': 'Monorepo ignore rules own generated assets.',
    'assets/qsmbly-app.png': 'Keep the shared shell and existing landing design.',
    'css/landing.css': 'Keep the shared design system.',
    'css/modern-styles.css': 'New controls use the shared design system.',
    'coi-serviceworker.js': 'Use the shared cross-origin isolation support.',
    'scripts/capture-landing-shot.mjs': 'Upstream landing screenshot tooling.',
    'serve.py': 'Use monorepo serving and header support.',
}
report = []
for line in git('diff', '--name-status', args.base, args.target).decode().splitlines():
    status, name = line.split('\t')
    destination = renames.get(name, name)
    if name in excluded:
        report.append({'path': name, 'status': 'excluded', 'reason': excluded[name]})
        continue
    local = root / 'apps/qsmbly' / destination
    staged = output / destination
    staged.parent.mkdir(parents=True, exist_ok=True)
    if status == 'D':
        report.append({'path': destination, 'status': 'delete'})
        continue
    upstream = git('show', f'{args.target}:{name}')
    if name in renames:
        upstream = upstream.replace(b'PipelineExecutor', b'QsmPipelineController')
    if status == 'A':
        if local.exists() and local.read_bytes() != upstream:
            raise ValueError(f'New upstream file already exists locally: {destination}')
        staged.write_bytes(upstream)
        report.append({'path': destination, 'status': 'add'})
        continue
    base = git('show', f'{args.base}:{name}')
    if name in renames:
        base = base.replace(b'PipelineExecutor', b'QsmPipelineController')
    base_file = output / 'base'
    remote_file = output / 'remote'
    base_file.write_bytes(base)
    remote_file.write_bytes(upstream)
    merged = subprocess.run(['git', 'merge-file', '-p', '-L', 'local', '-L', 'base',
                             '-L', 'upstream', str(local), str(base_file), str(remote_file)],
                            stdout=subprocess.PIPE, check=False)
    if merged.returncode < 0 or merged.returncode > 127:
        raise RuntimeError(f'Cannot merge {destination}')
    staged.write_bytes(merged.stdout)
    report.append({'path': destination, 'status': 'conflict' if merged.returncode else 'merged'})
for name in ['base', 'remote']:
    (output / name).unlink(missing_ok=True)
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
for item in report:
    print(f'{item["status"]:10} {item["path"]}')
print(f'Review merged files and resolve conflicts in {output}; no checkout files were changed.')
