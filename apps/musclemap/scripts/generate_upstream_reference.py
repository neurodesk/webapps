"""Generate a pinned MuscleMap reference with explicit inference authority.

Requires Python 3.11, torch 2.4.1+cpu, MONAI 1.3.2, nibabel and NumPy.
The bounded mode requires bounded_reference.py beside this runner. It changes
inference scheduling and channel inversion, and is recorded as modified upstream.
"""
import argparse
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import torch
import monai

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--upstream-directory', type=Path, required=True)
parser.add_argument('--checkpoint', type=Path, required=True)
parser.add_argument('--release', type=Path, required=True)
parser.add_argument('--chunk-size', type=int, required=True)
parser.add_argument('--overlap-percent', type=int, required=True)
parser.add_argument('--threads', type=int, default=4)
parser.add_argument('--bounded-channel-inversion', action='store_true')
args = parser.parse_args()
for name in ['input', 'output', 'upstream_directory', 'checkpoint', 'release']:
    setattr(args, name, getattr(args, name).resolve())
if args.chunk_size < 1 or not 0 <= args.overlap_percent < 100 or args.threads < 1:
    parser.error('chunk size and threads must be positive; overlap must be 0..99')
if torch.__version__ != '2.4.1+cpu' or monai.__version__ != '1.3.2':
    raise RuntimeError('Pinned reference requires torch 2.4.1+cpu and MONAI 1.3.2')


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


release = json.loads(args.release.read_text())
revision = '6e1e1eb6732337c13cab53bd5cc800c69024774f'
assert release['upstream']['revision'] == revision
model = next(model for model in release['models'] if model['status'] == 'active')
config = args.release.parent / model['config']['path']
assert sha(config) == model['config']['sha256']
assert sha(args.checkpoint) == model['source']['checkpointSha256']
sources = {
    'mm_segment.py': '51e78b1420ae921d4ee8e9e11907667abfe73c929b4b2016d2214b7489bb03ac',
    'mm_util.py': '15f5535d965c82d536fb6bb470cc82e7802b74c22313e75b7bbb6a1db8b8c197',
}
for name, expected in sources.items():
    assert sha(args.upstream_directory / name) == expected, name
sys.path.insert(0, str(args.upstream_directory))
spec = importlib.util.spec_from_file_location('mm_segment', args.upstream_directory / 'mm_segment.py')
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)
upstream.get_model_and_config_paths = lambda *unused: (str(args.checkpoint), str(config))
import mm_util

args.output.mkdir(parents=True, exist_ok=True)
output_path = args.output / (args.input.name.removesuffix('.gz').removesuffix('.nii') + '_dseg.nii.gz')
if output_path.exists():
    raise FileExistsError('Output already exists; use a fresh output directory')
torch.set_num_threads(args.threads)
torch.set_num_interop_threads(1)
inference = mm_util._run_inference_on_file
if args.bounded_channel_inversion:
    from bounded_reference import run_inference_on_file
    inference = run_inference_on_file
chunk_records = []


def observed_inference(*positional, **keywords):
    started = time.perf_counter()
    print(json.dumps({'startedChunk': str(positional[0])}), flush=True)
    result = inference(*positional, **keywords)
    record = {'file': Path(positional[0]).name, 'seconds': time.perf_counter() - started,
              'shape': list(result.shape), 'nonzero': int(np.count_nonzero(result))}
    chunk_records.append(record)
    np.save(args.output / (Path(positional[0]).stem + '-before-components.npy'), result)
    print(json.dumps(record), flush=True)
    return result


mm_util._run_inference_on_file = observed_inference
sys.argv = ['mm_segment.py', '-i', str(args.input), '-r', 'wholebody', '-g', 'N',
            '-s', str(args.overlap_percent), '-c', str(args.chunk_size),
            '-o', str(args.output), '--model_version', '1.4']
started = time.perf_counter()
upstream.main()
if not output_path.is_file():
    raise RuntimeError('Upstream failed without producing the reference')
image = nib.load(args.input)
result = nib.load(output_path)
assert result.shape == image.shape
assert np.array_equal(result.affine, image.affine)
labels, counts = np.unique(np.asarray(result.dataobj), return_counts=True)
metadata = {
    'input': args.input.name, 'inputSha256': sha(args.input),
    'output': output_path.name, 'outputSha256': sha(output_path),
    'checkpointSha256': sha(args.checkpoint), 'configSha256': sha(config),
    'upstreamRevision': revision, 'sourceSha256': sources,
    'execution': 'bounded-channel-inversion' if args.bounded_channel_inversion else 'unmodified-upstream',
    'runnerSha256': sha(Path(__file__)),
    'boundedInferenceSha256': sha(Path(__file__).with_name('bounded_reference.py')) if args.bounded_channel_inversion else None,
    'chunkSize': args.chunk_size, 'overlapPercent': args.overlap_percent,
    'threads': args.threads, 'torch': torch.__version__, 'monai': monai.__version__,
    'numpy': np.__version__, 'nibabel': nib.__version__, 'python': sys.version,
    'seconds': time.perf_counter() - started, 'shape': list(result.shape),
    'affine': result.affine.tolist(), 'labels': {str(int(k)): int(v) for k, v in zip(labels, counts)},
    'chunks': chunk_records,
    'limitations': ['This is an upstream implementation reference, not anatomical ground truth.'] +
        (['Inference scheduling and channel inversion were modified to bound memory.'] if args.bounded_channel_inversion else []),
}
(args.output / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata), flush=True)
