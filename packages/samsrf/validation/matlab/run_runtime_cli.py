#!/usr/bin/env python3
"""Run the compiled SamSrfAnalysis image on a staged cli_plan.py matrix.

Every container runs without a network, so no license server can be reached;
with a read-only root file system and read-only inputs; as the calling user;
and in its own freshly staged results directory. The input tree is hashed
before and after the matrix, and must not change.

Usage:
  run_runtime_cli.py run IMAGE PLAN_JSON BUNDLE RESULTS_ROOT
  run_runtime_cli.py interrupt IMAGE PLAN_JSON BUNDLE RESULTS_ROOT RUN_ID SECONDS
  run_runtime_cli.py failure IMAGE BUNDLE RESULTS_DIRECTORY

IMAGE is a registry digest (name@sha256:...) or, before publication, a local
image ID (sha256:...). Tags are refused: they do not identify the bytes run.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from capture_environment import CONTROLS
from cli_plan import results_argv, tree_hashes

DIGEST = re.compile(r'^(?:[a-z0-9][a-z0-9._/:-]*@)?sha256:[0-9a-f]{64}$')
RESULTS = '/results'


def require_pinned(image):
    if not DIGEST.match(image):
        raise ValueError('Pass an image digest or local image ID, not a tag')
    return image


def docker_command(image, bundle, directory, argv, name=None, detach=False):
    # --init forwards SIGINT/SIGTERM: the application would otherwise be PID 1,
    # which ignores signals it has no handler for.
    command = ['docker', 'run', '--init', '--network', 'none', '--read-only',
               '--tmpfs', '/tmp:rw,exec,size=4g',
               '--user', f'{os.getuid()}:{os.getgid()}',
               '--env', 'HOME=/tmp', '--env', 'MCR_CACHE_ROOT=/tmp/mcr-cache']
    for key, value in CONTROLS.items():
        command += ['--env', f'{key}={value}']
    command += ['--volume', f'{Path(bundle).resolve()}:/input:ro',
                '--volume', f'{Path(directory).resolve()}:{RESULTS}',
                '--workdir', RESULTS]
    if name:
        command += ['--name', name]
    command += ['--detach'] if detach else ['--rm']
    return command + [image, *argv]


def inspect(image):
    data = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image]))[0]
    return {'reference': image, 'id': data['Id'], 'repoDigests': data.get('RepoDigests', []),
            'created': data.get('Created'), 'architecture': data.get('Architecture')}


def host():
    def output(command):
        try:
            return subprocess.run(command, capture_output=True, text=True, check=False).stdout
        except FileNotFoundError:
            return ''
    return {'lscpu': output(['lscpu']), 'uname': output(['uname', '-a']),
            'docker': output(['docker', 'version', '--format', '{{json .}}'])}


def staged(directory):
    names = sorted(path.name for path in Path(directory).iterdir())
    if names != ['SamSrf_defaults.json']:
        raise ValueError(f'{directory} is not a freshly staged run directory')


def write(path, value):
    with Path(path).open('x') as receipt:
        json.dump(value, receipt, indent=2)
        receipt.write('\n')


def run_matrix(image, plan, bundle, root, runner=subprocess.run):
    root = Path(root)
    receipts = root / 'receipts'
    receipts.mkdir()
    before = tree_hashes(bundle)
    write(receipts / 'environment.json', {'execution': 'compiled-runtime', 'image': inspect(image),
                                          'requested': CONTROLS, 'host': host(),
                                          'network': 'none', 'inputs': 'read-only'})
    failures = 0
    for run in plan['runs']:
        directory = root / run['id']
        staged(directory)
        argv = results_argv(run, RESULTS)
        started = time.monotonic()
        with (receipts / f'{run["id"]}.log').open('x') as log:
            completed = runner(docker_command(image, bundle, directory, argv),
                               stdout=log, stderr=subprocess.STDOUT, check=False)
        status = 'succeeded' if completed.returncode == 0 else 'failed'
        failures += status == 'failed'
        write(receipts / f'{run["id"]}.json', {
            'id': run['id'], 'execution': 'compiled-runtime', 'argv': argv,
            'exitCode': completed.returncode, 'status': status,
            'seconds': time.monotonic() - started})
        print(f'{run["id"]}: {status} ({completed.returncode})', flush=True)
    after = tree_hashes(bundle)
    if before != after:
        raise RuntimeError('The compiled runs changed the read-only input bundle')
    write(receipts / 'inputs.json', {'sha256': before, 'unchanged': True})
    return failures


def interrupt(image, plan, bundle, root, run_id, seconds, grace=120):
    """Send SIGINT mid-run and require a prompt, nonzero exit."""
    run = next(item for item in plan['runs'] if item['id'] == run_id)
    directory = Path(root) / run_id
    staged(directory)
    name = f'samsrf-interrupt-{os.getpid()}'
    subprocess.run(docker_command(image, bundle, directory, results_argv(run, RESULTS),
                                  name=name, detach=True), check=True, stdout=subprocess.DEVNULL)
    try:
        time.sleep(seconds)
        running = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', name], text=True).strip()
        subprocess.run(['docker', 'kill', '--signal', 'INT', name], check=False, capture_output=True)
        deadline = time.monotonic() + grace
        forced = False
        while time.monotonic() < deadline:
            state = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', name]))
            if not state['Running']:
                break
            time.sleep(1)
        else:
            forced = True
            subprocess.run(['docker', 'kill', name], check=False, capture_output=True)
            state = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', name]))
        log = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, check=False)
    finally:
        subprocess.run(['docker', 'rm', '--force', name], check=False, capture_output=True)
    receipt = {'id': run_id, 'signal': 'SIGINT', 'afterSeconds': seconds,
               'runningWhenSignalled': running == 'true', 'exitCode': state['ExitCode'],
               'stoppedWithinGrace': not forced, 'graceSeconds': grace,
               'outputs': sorted(path.name for path in directory.iterdir()),
               'log': (log.stdout + log.stderr)[-4000:]}
    write(Path(root) / f'interrupt-{run_id}.json', receipt)
    if not receipt['runningWhenSignalled']:
        raise RuntimeError('The run finished before the interrupt; choose a shorter delay')
    if receipt['exitCode'] == 0 or not receipt['stoppedWithinGrace']:
        raise RuntimeError(f'Interrupted run did not stop with a failure status: {receipt["exitCode"]}')
    return receipt


def failure(image, bundle, directory):
    """A missing model must fail visibly with a nonzero status."""
    directory = Path(directory)
    staged(directory)
    argv = ['prf', '/input/models/does_not_exist', '/input/x001_lh/lh_ubars*.gii', f'-outpath={RESULTS}']
    completed = subprocess.run(docker_command(image, bundle, directory, argv),
                               capture_output=True, text=True, check=False)
    receipt = {'argv': argv, 'exitCode': completed.returncode,
               'output': (completed.stdout + completed.stderr)[-4000:]}
    write(directory.parent / f'failure-{directory.name}.json', receipt)
    if completed.returncode == 0:
        raise RuntimeError('A missing model returned exit status 0')
    return receipt


def main(arguments):
    command = arguments[:1]
    if command == ['run'] and len(arguments) == 5:
        image = require_pinned(arguments[1])
        plan = json.loads(Path(arguments[2]).read_text())
        failures = run_matrix(image, plan, arguments[3], arguments[4])
        print(f'Ran {len(plan["runs"])} compiled SamSrfAnalysis commands; {failures} failed.')
    elif command == ['interrupt'] and len(arguments) == 7:
        image = require_pinned(arguments[1])
        plan = json.loads(Path(arguments[2]).read_text())
        interrupt(image, plan, arguments[3], arguments[4], arguments[5], float(arguments[6]))
    elif command == ['failure'] and len(arguments) == 4:
        failure(require_pinned(arguments[1]), arguments[2], arguments[3])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
