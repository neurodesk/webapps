#!/usr/bin/env python3
"""Stage upstream examples for the canonical dataset; publish only with --publish."""
import argparse
import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--publish', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
scratch = Path(os.environ['TMPDIR']) / 'webapps-example-mirror'
scratch.mkdir(parents=True, exist_ok=True)
cache = Path(os.environ['TMPDIR']) / 'webapps-example-assets'
lock = json.loads((root / 'registry/offline-assets.lock.json').read_text())
plan = []
for path in sorted((root / 'apps').glob('*/examples.json')):
    for example in json.loads(path.read_text()):
        if example.get('generated'):
            relative = Path(path.parent.name) / example['id'] / 'synthetic_prostate_signal_voids.nii'
            data = (scratch / relative).read_bytes()
            plan.append({'app': path.parent.name, 'example': example['id'],
                         'generated': example['generated'], 'path': str(relative),
                         'sha256': hashlib.sha256(data).hexdigest()})
        for asset in example['files']:
            url = asset['url']
            if url.startswith('https://huggingface.co/datasets/neurodeskorg/webapps/resolve/'):
                continue
            relative = Path(path.parent.name) / example['id'] / asset.get('path', asset['name'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError(f'Unsafe example path: {relative}')
            plan.append({'app': path.parent.name, 'example': example['id'], 'url': url,
                         'path': str(relative), 'sha256': lock['assets'][url]['sha256'],
                         'description': example['description']})


if not plan:
    print('All examples already use the canonical mirror; nothing to publish.')
    sys.exit(0)

def stage(item):
    if 'generated' in item:
        return (scratch / item['path']).stat().st_size
    cached = cache / hashlib.sha256(item['url'].encode()).hexdigest()
    if cached.exists():
        data = cached.read_bytes()
    else:
        with urllib.request.urlopen(item['url'], timeout=180) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError(f"Checksum mismatch: {item['url']}")
    target = scratch / item['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return len(data)

with ThreadPoolExecutor(max_workers=4) as pool:
    sizes = list(pool.map(stage, plan))
(scratch / 'sources.json').write_text(json.dumps(plan, indent=2) + '\n')
print(f'Staged {len(plan)} assets ({sum(sizes):,} bytes) at {scratch}')
if args.publish:
    from huggingface_hub import HfApi, get_token
    if not get_token():
        raise RuntimeError('Authenticate with Hugging Face before publishing the prepared examples.')
    commit = HfApi().upload_folder(
        repo_id='neurodeskorg/webapps', repo_type='dataset', folder_path=str(scratch),
        path_in_repo='examples', commit_message='Add curated browser examples and provenance',
        allow_patterns=['sources.json', *[item['path'] for item in plan],
                        *[item['path'] + '.json' for item in plan if 'generated' in item]],
    )
    prefix = f'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/{commit.oid}/examples/'
    targets = {item['url']: prefix + item['path'] for item in plan if 'url' in item}
    for path in sorted((root / 'apps').glob('*/examples.json')):
        examples = json.loads(path.read_text())
        for example in examples:
            if example.get('generated'):
                item = next(item for item in plan if item['app'] == path.parent.name and item['example'] == example['id'])
                example['provenance'] = example.pop('generated')
                example['files'] = [{'role': 't1', 'name': Path(item['path']).name,
                                     'url': prefix + item['path'], 'sha256': item['sha256']}]
            old_source = example.get('sourceUrl')
            for asset in example['files']:
                asset['url'] = targets.get(asset['url'], asset['url'])
            if old_source:
                example['sourceUrl'] = prefix + path.parent.name + '/' + example['id'] + '/'
        path.write_text(json.dumps(examples, indent=2, ensure_ascii=False) + '\n')
    print(f'Pinned manifests to dataset commit {commit.oid}. Run scripts/lock-example-assets.mjs next.')
