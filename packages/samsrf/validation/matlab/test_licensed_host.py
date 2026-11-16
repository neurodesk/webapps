"""Exercise the local driver's command construction without licensed MATLAB."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


DRIVER = Path(__file__).parent / 'licensed-host' / 'build_and_validate.sh'
STUB = r'''
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == 'git':
    if 'reference-spm' in args:
        # The SPM checkout runs real git against a local fixture (see spm_fixture).
        os.execv(os.environ['TEST_REAL_GIT'], ['git'] + args)
    if '--show-toplevel' in args:
        print(os.environ['TEST_REPO'])
    elif 'clone' in args:
        pathlib.Path(args[-1]).mkdir()
elif name == 'docker':
    if args[:2] == ['image', 'inspect']:
        print('sha256:stub')
elif name == 'python3':
    if args[0] == '-c':
        print('case 10' if 'seconds' in args[1] else 'pinned-commit')
    elif pathlib.Path(args[0]).name == 'cli_plan.py' and args[1] == 'hash':
        bundle = pathlib.Path(args[2])
        bundle.mkdir(parents=True)
        (bundle / 'SamSrf_defaults.json').write_text('{}')
elif name == 'matlab_batch.sh':
    with open(os.environ['TEST_COMMANDS'], 'a') as handle:
        handle.write(json.dumps(args) + '\n')
    sys.exit(int(os.environ.get('TEST_MATLAB_EXIT', '0')))
else:
    raise RuntimeError(name)
'''


def spm_fixture(root, root_files=True):
    """A local SPM stand-in: root files, the three classes and a directory to leave out."""
    fixture = root / 'spm12'
    for path in ['@gifti/gifti.m', '@xmltree/xmltree.m', '@file_array/file_array.m',
                 'toolbox/left_out.m'] + (['spm.m', 'Contents.m'] if root_files else []):
        (fixture / path).parent.mkdir(parents=True, exist_ok=True)
        (fixture / path).write_text('% fixture\n')
    git = ['git', '-C', str(fixture), '-c', 'user.name=test', '-c', 'user.email=test@example.org']
    subprocess.run(['git', 'init', '--quiet', str(fixture)], check=True)
    subprocess.run(git + ['add', '--all'], check=True)
    subprocess.run(git + ['commit', '--quiet', '--message', 'fixture'], check=True)
    subprocess.run(git + ['tag', 'pinned-commit'], check=True)
    return fixture


class LicensedHostCommands(unittest.TestCase):
    def run_driver(self, root, exit_code=0, spm_root_files=True):
        fixture = spm_fixture(root, spm_root_files)
        repo = root / "O'Brien's repo"
        here = repo / 'packages/samsrf/validation/matlab/licensed-host'
        here.mkdir(parents=True)
        shutil.copyfile(DRIVER, here / DRIVER.name)
        executable = '#!' + sys.executable + '\n' + STUB
        launcher = here / 'matlab_batch.sh'
        launcher.write_text(executable)
        launcher.chmod(0o755)
        binaries = root / 'bin'
        binaries.mkdir()
        for name in ['git', 'docker', 'python3']:
            stub = binaries / name
            stub.write_text(executable)
            stub.chmod(0o755)
        matlab_root = root / "MATLAB's install"
        matlab_root.mkdir()
        (matlab_root / 'VersionInfo.xml').write_text('<version>23.2.0.3097123</version>')
        work = root / "O'Brien'); error('unexpected'); % work"
        commands = root / 'commands.jsonl'
        env = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ['PATH'],
                   TEST_REPO=str(repo), TEST_COMMANDS=str(commands),
                   TEST_MATLAB_EXIT=str(exit_code), TEST_REAL_GIT=shutil.which('git'),
                   GIT_CONFIG_COUNT='2',
                   GIT_CONFIG_KEY_0=f'url.{fixture.as_uri()}.insteadOf',
                   GIT_CONFIG_VALUE_0='https://github.com/spm/spm12.git',
                   GIT_CONFIG_KEY_1='protocol.file.allow', GIT_CONFIG_VALUE_1='always')
        result = subprocess.run(['bash', str(here / DRIVER.name), str(work),
                                 '27000@license-server', str(matlab_root)],
                                env=env, text=True, capture_output=True)
        recorded = ([json.loads(line) for line in commands.read_text().splitlines()]
                    if commands.exists() else [])
        return result, recorded, here.parent, work

    def test_matlab_arguments_preserve_apostrophes_as_data(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            result, commands, matlab, work = self.run_driver(Path(directory))
            self.assertEqual(result.returncode, 0, result.stderr)
            cli = work / 'samsrf-cli'
            common = [work / 'reference-source', work / 'reference-spm']
            expected = [
                ('prepare_cli_bundle', common + [work / 'matrix-input', cli / 'bundle', cli / 'plan.json']),
                ('run_source_cli', common + [cli / 'plan.json', cli / 'source-1']),
                ('verify_cli_hrf', common + [cli / 'plan.json', cli / 'source-1', cli / 'source-1-direct']),
                ('run_source_cli', common + [cli / 'plan.json', cli / 'source-2']),
            ]
            self.assertEqual(len(commands), len(expected))
            literal = r"'(?:[^']|'')*'"
            for arguments, (function, paths) in zip(commands, expected):
                self.assertEqual(len(arguments), 1)
                match = re.fullmatch(r'addpath\((' + literal + r')\); ' + function
                                     + r'\((' + literal + r'(?:,' + literal + r')*)\)', arguments[0])
                self.assertIsNotNone(match, arguments[0])
                decoded = [value[1:-1].replace("''", "'")
                           for value in re.findall(literal, match[0])]
                self.assertEqual(decoded, [str(matlab)] + [str(path) for path in paths])

    def test_spm_checkout_keeps_root_files_and_only_the_three_classes(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            result, _, _, work = self.run_driver(Path(directory))
            self.assertEqual(result.returncode, 0, result.stderr)
            spm = work / 'reference-spm'
            self.assertEqual(sorted(path.name for path in spm.iterdir() if path.name != '.git'),
                             ['@file_array', '@gifti', '@xmltree', 'Contents.m', 'spm.m'])

    def test_spm_checkout_without_spm_m_stops_before_matlab(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            result, commands, _, _ = self.run_driver(Path(directory), spm_root_files=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn('no spm.m', result.stderr)
            self.assertEqual(commands, [])

    def test_matlab_failure_stops_driver(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            result, commands, _, _ = self.run_driver(Path(directory), exit_code=37)
            self.assertEqual(result.returncode, 37, result.stderr)
            self.assertEqual(len(commands), 1)


if __name__ == '__main__':
    unittest.main()
