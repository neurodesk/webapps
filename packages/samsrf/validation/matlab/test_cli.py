import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import zlib

import h5py
import numpy

import cli_plan
import compare_cli
import run_runtime_cli

DIGEST = 'ghcr.io/neurodesk/samsrf-reference@sha256:' + '0' * 64


def scratch():
    return tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))


def write_gifti(path, values, dimensions=None, order='RowMajorOrder'):
    raw = base64.b64encode(zlib.compress(numpy.asarray(values, '<f4').tobytes())).decode()
    dimensions = dimensions or (len(values), 1)
    shape = ' '.join(f'Dim{axis}="{size}"' for axis, size in enumerate(dimensions))
    path.write_text(
        '<?xml version="1.0"?><GIFTI><DataArray DataType="NIFTI_TYPE_FLOAT32" '
        f'Encoding="GZipBase64Binary" Endian="LittleEndian" Dimensionality="{len(dimensions)}" '
        f'{shape} ArrayIndexingOrder="{order}">'
        '<MetaData><MD><Name>Name</Name><Value>x0</Value></MD></MetaData>'
        f'<Data>{raw}</Data></DataArray></GIFTI>')


def write_mat(path, data, kind='double', folder='/results/a', labels=None):
    with h5py.File(path, 'w') as handle:
        srf = handle.create_group('Srf')
        srf.attrs['MATLAB_class'] = numpy.bytes_('struct')
        values = numpy.tile(numpy.asarray(data, 'f8' if kind == 'double' else 'f4')[:, None], (1, len(labels)))
        dataset = srf.create_dataset('Data', data=values)
        dataset.attrs['MATLAB_class'] = numpy.bytes_(kind)
        text = srf.create_dataset('Structural', data=numpy.frombuffer(folder.encode('utf-16-le'), '<u2'))
        text.attrs['MATLAB_class'] = numpy.bytes_('char')
        handle.create_group('#refs#')
        references = []
        for index, label in enumerate(labels):
            values = handle['#refs#'].create_dataset(str(index), data=numpy.frombuffer(label.encode('utf-16-le'), '<u2').reshape(-1, 1))
            values.attrs['MATLAB_class'] = numpy.bytes_('char')
            references.append(values.ref)
        cell = srf.create_dataset('Values', data=numpy.array([references], dtype=h5py.ref_dtype))
        cell.attrs['MATLAB_class'] = numpy.bytes_('cell')
        handle_group = srf.create_group('Prf')
        handle_group.attrs['MATLAB_class'] = numpy.bytes_('function_handle')


class Plan(unittest.TestCase):
    def test_every_case_runs_in_both_precisions_with_its_own_model(self):
        plan = cli_plan.plan()
        self.assertEqual(len(plan['runs']), 2 * len(cli_plan.CASES))
        self.assertEqual(len({run['id'] for run in plan['runs']}), len(plan['runs']))
        self.assertEqual({run['algorithm'] for run in plan['runs']}, {'prf', 'rc', 'cf'})
        for run in plan['runs']:
            self.assertEqual(run['argv'][1], f'/input/models/{run["model"]["Name"]}')
            self.assertEqual(run['argv'][2], run['argv'][2].lower())
            self.assertIn('-outpath={results}', run['argv'])
            self.assertNotIn('{precision}', json.dumps(run['model']))
            if run['algorithm'] == 'cf':
                self.assertTrue(run['model']['Template'].endswith(f'_benson_{run["precision"]}.mat'))

    def test_models_name_the_relative_hrf_file_and_stage_copies_it(self):
        with scratch() as root:
            bundle = Path(root) / 'bundle'
            bundle.mkdir()
            (bundle / 'SamSrf_defaults.json').write_text('{}')
            (bundle / 'hrf_custom.mat').write_bytes(b'parameters')
            plan = cli_plan.plan()
            cli_plan.write_models(plan, bundle)
            custom = json.loads((bundle / 'models' / 'prf_custom_hrf_lh_single.json').read_text())
            # SamSrf takes the subject-HRF route only when the name starts with hrf_.
            self.assertEqual(custom['Hrf'], 'hrf_custom')
            self.assertEqual(json.loads((bundle / 'models' / 'prf_gaussian_rh_double.json').read_text())['Hrf'], 0)
            self.assertEqual(len(list((bundle / 'models').iterdir())), len(plan['runs']))
            cli_plan.stage(plan, bundle, Path(root) / 'results')
            for run in plan['runs']:
                directory = Path(root) / 'results' / run['id']
                self.assertTrue(cli_plan.is_staged(directory))
                self.assertEqual((directory / 'hrf_custom.mat').exists(), 'custom_hrf' in run['id'])
            (directory / 'output.mat').write_text('')
            self.assertFalse(cli_plan.is_staged(directory))

    def test_stage_selects_precision_and_refuses_reuse(self):
        with scratch() as root:
            bundle = Path(root) / 'bundle'
            bundle.mkdir()
            (bundle / 'SamSrf_defaults.json').write_text('{"def_64bit": false, "def_disp": true}')
            (bundle / 'hrf_custom.mat').write_bytes(b'')
            plan = cli_plan.plan()
            cli_plan.stage(plan, bundle, Path(root) / 'results')
            for run in plan['runs']:
                defaults = json.loads((Path(root) / 'results' / run['id'] / 'SamSrf_defaults.json').read_text())
                self.assertEqual(defaults, {'def_64bit': run['precision'] == 'double', 'def_disp': True})
            with self.assertRaises(FileExistsError):
                cli_plan.stage(plan, bundle, Path(root) / 'results')


class Runtime(unittest.TestCase):
    def test_tags_are_not_accepted_as_image_identity(self):
        for image in ['samsrf-reference:41ed1e96-r2023b', 'ghcr.io/x/y:latest', 'sha256:abc']:
            with self.subTest(image=image), self.assertRaises(ValueError):
                run_runtime_cli.require_pinned(image)
        self.assertEqual(run_runtime_cli.require_pinned(DIGEST), DIGEST)
        run_runtime_cli.require_pinned('sha256:' + 'a' * 64)

    def test_container_is_isolated_from_network_and_writable_inputs(self):
        command = run_runtime_cli.docker_command(DIGEST, 'bundle', 'out', ['prf', 'm'])
        joined = ' '.join(command)
        self.assertIn('--network none', joined)
        self.assertIn('--read-only', command)
        self.assertIn('--init', command)
        self.assertIn(f'{Path("bundle").resolve()}:/input:ro', command)
        self.assertIn('MKL_CBWR=COMPATIBLE', command)
        self.assertEqual(command[-3:], [DIGEST, 'prf', 'm'])

    def run_matrix(self, runner):
        root = tempfile.mkdtemp(dir=os.environ.get('TMPDIR'))
        bundle = Path(root) / 'bundle'
        bundle.mkdir()
        (bundle / 'SamSrf_defaults.json').write_text('{}')
        (bundle / 'hrf_custom.mat').write_bytes(b'')
        plan = {'runs': cli_plan.plan()['runs'][:2]}
        cli_plan.stage(plan, bundle, Path(root) / 'results')
        with mock.patch.object(run_runtime_cli, 'inspect', return_value={'id': 'x'}):
            failures = run_runtime_cli.run_matrix(DIGEST, plan, bundle, Path(root) / 'results', runner=runner)
        return root, failures

    def test_receipts_record_exit_status_and_unchanged_inputs(self):
        calls = []

        def runner(command, **_):
            calls.append(command)
            return subprocess.CompletedProcess(command, len(calls) - 1)

        root, failures = self.run_matrix(runner)
        receipts = Path(root) / 'results' / 'receipts'
        self.assertEqual(failures, 1)
        self.assertEqual(json.loads((receipts / 'prf_gaussian_lh_average_single.json').read_text())['status'], 'failed')
        self.assertTrue(json.loads((receipts / 'inputs.json').read_text())['unchanged'])
        self.assertTrue(all('/results' in ' '.join(call) and '{results}' not in ' '.join(call) for call in calls))

    def test_a_run_that_writes_its_inputs_fails_the_matrix(self):
        def runner(command, **_):
            mount = next(value for value in command if value.endswith(':/input:ro'))
            Path(mount.split(':')[0], 'written').write_text('x')
            return subprocess.CompletedProcess(command, 0)

        with self.assertRaises(RuntimeError):
            self.run_matrix(runner)


class Compare(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=os.environ.get('TMPDIR')))
        run = next(run for run in cli_plan.plan()['runs'] if run['id'] == 'prf_gaussian_rh_double')
        run['id'] = 'a'
        run['model']['Name'] = 'a'
        self.plan = {'runs': [run]}
        self.mat, self.labels, self.maps = compare_cli.expected_results(run)

    def execution(self, name, data=(1.0, float('nan')), kind='double', status='succeeded', folder='/results/a'):
        root = self.root / name
        (root / 'a').mkdir(parents=True)
        (root / 'receipts').mkdir()
        (root / 'receipts' / 'a.json').write_text(json.dumps({'status': status}))
        (root / 'a' / 'SamSrf_defaults.json').write_text(name)
        for name in self.maps:
            write_gifti(root / 'a' / name, data)
        write_mat(root / 'a' / self.mat, data, kind, folder, self.labels)
        return root

    def test_identical_outputs_pass_and_paths_are_reported_not_gated(self):
        report = compare_cli.compare(self.plan, self.execution('source', folder='/tmp/source/a'), self.execution('compiled'))
        self.assertTrue(report['exact'], report)
        run = report['runs'][0]
        self.assertEqual(run['text'], [f'{self.mat}:Srf.Structural'])
        self.assertEqual(run['notCompared'], [f'{self.mat}:Srf.Prf (function_handle)'])
        self.assertEqual(run['arrays'], len(self.maps) + 2)

    def test_one_ulp_and_nonfinite_mask_differences_fail(self):
        nudged = numpy.nextafter(numpy.float32(1.0), numpy.float32(2.0))
        for data in [(float(nudged), float('nan')), (1.0, 0.0)]:
            with self.subTest(data=data):
                report = compare_cli.compare(self.plan, self.execution(f's{data}'), self.execution(f'c{data}', data))
                self.assertFalse(report['exact'])
        failures = report['runs'][0]['failures']
        self.assertFalse(failures[0]['nonfiniteMaskEqual'])

    def test_status_precision_and_shared_failures_are_gated(self):
        cases = [
            ('status', {'status': 'failed'}, {}),
            ('precision', {'kind': 'single'}, {'kind': 'single'}),
            ('shared', {'status': 'failed'}, {'status': 'failed'}),
        ]
        for name, first, second in cases:
            with self.subTest(name=name):
                report = compare_cli.compare(self.plan, self.execution(f'{name}1', **first),
                                             self.execution(f'{name}2', **second))
                self.assertFalse(report['exact'], report)


    def test_success_with_only_cache_arrays_is_rejected(self):
        first, second = self.execution('first'), self.execution('second')
        for root in (first, second):
            for name in [self.mat, *self.maps]:
                (root / 'a' / name).unlink()
            with h5py.File(root / 'a' / 'cache.mat', 'w') as handle:
                x = handle.create_dataset('X', data=[1.0])
                x.attrs['MATLAB_class'] = numpy.bytes_('double')
        self.assertFalse(compare_cli.compare(self.plan, first, second)['exact'])

    def test_shared_missing_map_data_labels_or_export_is_rejected(self):
        for omission in ['data', 'labels', 'export', 'empty']:
            with self.subTest(omission=omission):
                first, second = self.execution(omission + '1'), self.execution(omission + '2')
                for root in (first, second):
                    if omission == 'export':
                        (root / 'a' / self.maps[0]).unlink()
                    else:
                        with h5py.File(root / 'a' / self.mat, 'r+') as handle:
                            if omission == 'labels':
                                del handle['Srf/Values']
                            else:
                                del handle['Srf/Data']
                                if omission == 'empty':
                                    d = handle['Srf'].create_dataset('Data', data=numpy.zeros((0, len(self.labels))))
                                    d.attrs['MATLAB_class'] = numpy.bytes_('double')
                self.assertFalse(compare_cli.compare(self.plan, first, second)['exact'])

    def test_gifti_dimensions_and_indexing_order_are_compared(self):
        for dimensions, order in [((3, 2), 'RowMajorOrder'), ((2, 3), 'ColumnMajorOrder')]:
            with self.subTest(dimensions=dimensions, order=order):
                first = self.execution('first' + order)
                second = self.execution('second' + order)
                write_gifti(first / 'a' / self.maps[0], [1, 2, 3, 4, 5, 6], (2, 3))
                write_gifti(second / 'a' / self.maps[0], [1, 2, 3, 4, 5, 6], dimensions, order)
                self.assertFalse(compare_cli.compare(self.plan, first, second)['exact'])

    def test_malformed_gifti_dimensions_are_rejected(self):
        first = self.execution('first')
        path = first / 'a' / self.maps[0]
        write_gifti(path, [1, 2], (2, 3))
        with self.assertRaisesRegex(ValueError, 'dimensions'):
            compare_cli.read_gifti(path)

    def test_empty_mat_dimensions_are_compared(self):
        first, second = self.execution('first'), self.execution('second')
        for root, dimensions in [(first, [0, 3]), (second, [0, 99])]:
            with h5py.File(root / 'a' / self.mat, 'r+') as handle:
                empty = handle.create_dataset('Empty', data=numpy.array(dimensions, dtype='<u8'))
                empty.attrs['MATLAB_class'] = numpy.bytes_('double')
                empty.attrs['MATLAB_empty'] = numpy.uint8(1)
        self.assertFalse(compare_cli.compare(self.plan, first, second)['exact'])
        self.assertTrue(compare_cli.compare(self.plan, first, first)['exact'])

    def test_cell_container_dimensions_are_compared(self):
        first, second = self.execution('first'), self.execution('second')
        with h5py.File(second / 'a' / self.mat, 'r+') as handle:
            values = handle['Srf/Values'][()].reshape(2, 3)
            del handle['Srf/Values']
            cell = handle['Srf'].create_dataset('Values', data=values)
            cell.attrs['MATLAB_class'] = numpy.bytes_('cell')
        self.assertFalse(compare_cli.compare(self.plan, first, second)['exact'])


if __name__ == '__main__':
    unittest.main()
