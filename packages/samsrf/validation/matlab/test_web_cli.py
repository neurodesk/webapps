import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

import h5py
import numpy

import cli_plan
import compare_cli
import compare_web_cli as web_cli
from compare_web_cli import Inventory
import web_cli_outcome
from test_cli import scratch, write_gifti

PLAN = {run['id']: run for run in cli_plan.plan()['runs']}
VERTICES = 6
ROI = [1, 3, 4]
IMAGE = 'sha256:' + 'a' * 64


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_srf(path, data, roi, kind, labels, vertices=VERTICES, imaginary=None):
    dtype = '<f8' if kind == 'double' else '<f4'
    with h5py.File(path, 'w') as handle:
        srf = handle.create_group('Srf')
        srf.attrs['MATLAB_class'] = numpy.bytes_('struct')
        values = numpy.asarray(data, dtype)
        if imaginary is not None:
            compound = numpy.empty(values.shape, dtype=[('real', dtype), ('imag', dtype)])
            compound['real'] = values
            compound['imag'] = imaginary
            values = compound
        for name, value in (('Data', values), ('Roi', numpy.asarray(roi, dtype)[None, :]),
                            ('Vertices', numpy.zeros((3, vertices), dtype))):
            stored = srf.create_dataset(name, data=value)
            stored.attrs['MATLAB_class'] = numpy.bytes_(kind)
        refs = handle.create_group('#refs#')
        references = []
        for index, label in enumerate(labels):
            text = refs.create_dataset(str(index), data=numpy.frombuffer(label.encode('utf-16-le'), '<u2').reshape(-1, 1))
            text.attrs['MATLAB_class'] = numpy.bytes_('char')
            references.append(text.ref)
        cell = srf.create_dataset('Values', data=numpy.array([references], dtype=h5py.ref_dtype))
        cell.attrs['MATLAB_class'] = numpy.bytes_('cell')


class Fixture:
    """One web execution and one MATLAB execution of a plan subset, with full provenance."""

    def __init__(self, root, ids, kind='source', runner='node'):
        self.root = Path(root)
        self.web = self.root / 'web'
        self.matlab = self.root / 'matlab'
        self.kind = kind
        self.runner = runner
        self.plan = {'runs': [copy.deepcopy(PLAN[i]) for i in ids]}
        self.manifest = {f'models/{i}.json': sha(web_cli.model_bytes(PLAN[i]['model'])) for i in ids}
        self.manifest['x001_lh/lh_ubars1.gii'] = 'b' * 64
        self.plan_sha = sha(json.dumps(self.plan).encode())
        self.manifest_sha = sha(json.dumps(self.manifest).encode())
        rng = numpy.random.default_rng(7)
        self.maps = {}
        for run_id in ids:
            labels = compare_cli.expected_results(PLAN[run_id])[1]
            values = numpy.zeros((len(labels), VERTICES))
            values[:, ROI] = rng.standard_normal((len(labels), len(ROI)))
            if PLAN[run_id]['precision'] == 'single':
                values = values.astype('<f4').astype('<f8')
            self.maps[run_id] = values
        # Imaginary parts over every vertex, written to both executions where set.
        self.imaginary = {}
        self.status = {i: web_cli.expected_web_status(PLAN[i], runner) for i in ids}
        self.receipt = {i: 'succeeded' for i in ids}
        self.write()

    def write(self):
        for path in (self.web, self.matlab):
            if path.exists():
                shutil.rmtree(path)
        self.web.mkdir()
        (self.matlab / 'receipts').mkdir(parents=True)
        (self.web / 'environment.json').write_text(json.dumps({
            'runner': self.runner, 'planSha256': self.plan_sha, 'bundleSha256': self.manifest_sha,
            'wasmSha256': 'c' * 64}))
        (self.web / 'runs.json').write_text('[]')
        if self.kind == 'source':
            environment = {'executionMode': web_cli.SOURCE_MODE, 'matlab': '23.2.0.3097123 (R2023b) Update 11',
                           'cpu': 'Model name:            AMD EPYC 9V74 80-Core Processor\n'}
        else:
            environment = {'execution': 'compiled-runtime', 'image': {'id': IMAGE, 'repoDigests': []},
                           'host': {'lscpu': 'Model name: AMD EPYC\n'}}
            (self.matlab / 'receipts' / 'inputs.json').write_text(json.dumps({'sha256': self.manifest, 'unchanged': True}))
        (self.matlab / 'receipts' / 'environment.json').write_text(json.dumps(environment))
        execution = 'source' if self.kind == 'source' else 'compiled-runtime'
        for run in self.plan['runs']:
            run_id = run['id']
            argv = [value.replace(cli_plan.RESULTS, f'/somewhere/{run_id}') for value in run['argv']]
            (self.matlab / 'receipts' / f'{run_id}.json').write_text(json.dumps({
                'id': run_id, 'execution': execution, 'argv': argv, 'status': self.receipt[run_id]}))
            record = {'id': run_id, 'status': self.status[run_id]}
            mat, labels, names = compare_cli.expected_results(run)
            if self.receipt[run_id] == 'succeeded':
                (self.matlab / run_id).mkdir()
                imaginary = self.imaginary.get(run_id)
                write_srf(self.matlab / run_id / mat, self.maps[run_id][:, ROI].T, [v + 1 for v in ROI],
                          run['precision'], labels, imaginary=None if imaginary is None else imaginary[:, ROI].T)
                for index, name in enumerate(names):
                    write_gifti(self.matlab / run_id / name, self.maps[run_id][index])
            if self.status[run_id] == 'succeeded':
                directory = self.web / run_id
                directory.mkdir()
                data = numpy.asarray(self.maps[run_id], '<f8').tobytes()
                (directory / 'maps.f64').write_bytes(data)
                stem = mat[:-4]
                files = [*names, f'{stem}_pol.gii', f'{stem}_ecc.gii']
                for index, name in enumerate(files):
                    write_gifti(directory / name, self.maps[run_id][min(index, len(names) - 1)])
                record.update({'values': labels, 'vertices': VERTICES, 'roi': ROI, 'files': files, 'mapsSha256': sha(data)})
                if run_id in self.imaginary:
                    parts = numpy.asarray(self.imaginary[run_id], '<f8').tobytes()
                    (directory / 'maps.imag.f64').write_bytes(parts)
                    record['imaginarySha256'] = sha(parts)
            (self.web / f'{run_id}.web.json').write_text(json.dumps(record))

    def report(self, expect=None, allow=True):
        return web_cli.compare(self.plan, self.plan_sha, self.manifest, self.manifest_sha, self.web, self.matlab,
                               expect or self.kind, allow_unattested=allow)

    def edit_record(self, run_id, **changes):
        path = self.web / f'{run_id}.web.json'
        record = json.loads(path.read_text())
        record.update(changes)
        path.write_text(json.dumps(record))


class Base(unittest.TestCase):
    ids = ['rc_hull_lh_double']
    kind = 'source'
    runner = 'node'

    def setUp(self):
        self._scratch = scratch()
        self.x = Fixture(self._scratch.name, self.ids, self.kind, self.runner)
        self.id = self.ids[0]
        self.names = compare_cli.expected_results(PLAN[self.id])[2]

    def tearDown(self):
        self._scratch.cleanup()

    def run_class(self, report=None):
        return (report or self.x.report())['runs'][0]['class']


class Values(Base):
    def test_identical_maps_are_exact_and_name_their_execution(self):
        report = self.x.report()
        self.assertEqual(self.run_class(report), 'exact')
        self.assertEqual(report['summary']['exactMaps'], len(self.names))
        self.assertEqual(report['matlab']['kind'], 'source')
        self.assertTrue(report['matlab']['inputs'].startswith('unattested'))
        self.assertEqual(report['matlab']['cpu'], 'AMD EPYC 9V74 80-Core Processor')
        stem = compare_cli.expected_results(PLAN[self.id])[0][:-4]
        self.assertEqual(report['runs'][0]['notCompared']['webOnly'], [f'{stem}_ecc.gii', f'{stem}_pol.gii'])
        self.assertEqual(report['summary']['webOnlyFilesNotCompared'], 2)

    def test_one_ulp_in_a_double_map_differs_although_the_gifti_agrees(self):
        mat, labels, _ = compare_cli.expected_results(PLAN[self.id])
        data = self.x.maps[self.id][:, ROI].T.copy()
        data[1, 2] = numpy.nextafter(data[1, 2], numpy.inf)
        write_srf(self.x.matlab / self.id / mat, data, [v + 1 for v in ROI], 'double', labels)
        entry = self.x.report()['runs'][0]['maps'][2]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['srfData']['differing'], 1)
        self.assertEqual(entry['srfData']['maxUlp'], 1)
        self.assertTrue(entry['gifti']['exact'])

    def test_signed_zero_nan_and_imaginary_parts_differ(self):
        mat, labels, _ = compare_cli.expected_results(PLAN[self.id])
        self.x.maps[self.id][1, ROI[0]] = -0.0
        self.x.write()
        data = self.x.maps[self.id][:, ROI].T.copy()
        data[0, 1] = 0.0
        data[1, 0] = numpy.nan
        imaginary = numpy.zeros_like(data)
        imaginary[2, 3] = 1e-3
        write_srf(self.x.matlab / self.id / mat, data, [v + 1 for v in ROI], 'double', labels, imaginary=imaginary)
        run = self.x.report()['runs'][0]
        self.assertEqual(run['maps'][1]['srfData']['signedZeroOnly'], 1)
        self.assertEqual(run['maps'][1]['srfData']['maxAbsolute'], 0)
        self.assertFalse(run['maps'][0]['srfData']['nonfiniteMaskEqual'])
        self.assertEqual(run['maps'][3]['imaginaryNonzero'], 1)
        self.assertEqual(run['maps'][3]['imaginary']['differing'], 1)
        self.assertEqual(run['maps'][3]['class'], 'differs')
        self.assertTrue(run['matlabComplex'])


class Imaginary(Base):
    ids = ['prf_css_lh_double']

    def complex_maps(self):
        imaginary = numpy.zeros_like(self.x.maps[self.id])
        imaginary[0, ROI] = [-2e-3, 0.0, 5e-4]
        imaginary[-3, ROI] = [1e-3, -7e-4, 0.0]
        self.x.imaginary[self.id] = imaginary
        self.x.write()
        return imaginary

    def test_matching_imaginary_parts_are_exact(self):
        self.complex_maps()
        run = self.x.report()['runs'][0]
        self.assertEqual(run['class'], 'exact')
        self.assertTrue(run['matlabComplex'])
        self.assertEqual([entry['imaginaryNonzero'] for entry in run['maps']][0], 2)
        self.assertTrue(all(entry['imaginary']['exact'] for entry in run['maps']))

    def test_one_ulp_or_a_signed_zero_in_an_imaginary_part_differs(self):
        imaginary = self.complex_maps()
        mat, labels, _ = compare_cli.expected_results(PLAN[self.id])
        matlab = imaginary[:, ROI].T.copy()
        matlab[0, 0] = numpy.nextafter(matlab[0, 0], numpy.inf)
        matlab[1, 0] = -0.0
        write_srf(self.x.matlab / self.id / mat, self.x.maps[self.id][:, ROI].T, [v + 1 for v in ROI], 'double', labels,
                  imaginary=matlab)
        entry = self.x.report()['runs'][0]['maps'][0]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['imaginary']['differing'], 2)
        self.assertEqual(entry['imaginary']['signedZeroOnly'], 1)
        self.assertEqual(entry['imaginary']['maxUlp'], 1)
        self.assertTrue(entry['srfData']['exact'] and entry['gifti']['exact'])

    def test_a_web_run_without_imaginary_parts_differs_from_complex_matlab_maps(self):
        self.complex_maps()
        (self.x.web / self.id / 'maps.imag.f64').unlink()
        self.x.edit_record(self.id, imaginarySha256=None)
        run = self.x.report()['runs'][0]
        self.assertEqual(run['class'], 'differs')
        self.assertEqual(run['maps'][0]['imaginary']['differing'], 2)
        self.assertTrue(run['maps'][0]['srfData']['exact'])

    def test_imaginary_file_damage_is_an_inventory_error(self):
        self.complex_maps()
        path = self.x.web / self.id / 'maps.imag.f64'
        good = path.read_bytes()
        path.write_bytes(good + bytes(8))
        self.assertEqual(self.run_class(), 'inventory-error')
        path.write_bytes(good[:-8] + numpy.float64(1.0).tobytes())
        self.assertIn('hash', self.x.report()['runs'][0]['error'])
        path.write_bytes(good)
        self.x.edit_record(self.id, imaginarySha256=None)
        self.assertIn('differs from its record', self.x.report()['runs'][0]['error'])


class Outcome(Base):
    ids = ['rc_hull_lh_double', 'prf_css_lh_double']

    def test_fractional_comparison_count_fails_public_command(self):
        report = self.x.report()
        frozen = self.x.root / 'outcome.json'
        frozen.write_text(json.dumps(web_cli_outcome.outcome(report)))
        report['runs'][0]['maps'][0]['srfData']['count'] = 3.5
        path = self.x.root / 'report.json'
        path.write_text(json.dumps(report))
        result = subprocess.run([sys.executable, str(Path(web_cli_outcome.__file__)),
                                 'check', str(frozen), str(path)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('count', result.stderr)

    def check(self, frozen):
        path = self.x.root / 'report.json'
        path.write_text(json.dumps(self.x.report()))
        return web_cli_outcome.differences(frozen, web_cli_outcome.outcome(json.loads(path.read_text())))

    def test_an_unchanged_outcome_passes_and_any_change_fails(self):
        frozen = web_cli_outcome.outcome(self.x.report())
        self.assertEqual(frozen['runs']['rc_hull_lh_double'], {'class': 'exact', 'maps': {name: 'exact' for name in compare_cli.expected_results(PLAN['rc_hull_lh_double'])[1]}})
        self.assertEqual(self.check(frozen), [])
        mat, labels, _ = compare_cli.expected_results(PLAN[self.id])
        data = self.x.maps[self.id][:, ROI].T.copy()
        data[0, 1] = numpy.nextafter(data[0, 1], numpy.inf)
        write_srf(self.x.matlab / self.id / mat, data, [v + 1 for v in ROI], 'double', labels)
        found = self.check(frozen)
        self.assertIn(f'/runs/{self.id}/class: expected "exact", found "differs"', found)
        self.assertIn(f'/runs/{self.id}/maps/{labels[1]}: expected "exact", found {{"srfData": 1, "imaginary": 0, "gifti": 0}}', found)

    def test_a_better_outcome_or_another_host_also_fails(self):
        mat, labels, _ = compare_cli.expected_results(PLAN[self.id])
        data = self.x.maps[self.id][:, ROI].T.copy()
        data[0, 1] = numpy.nextafter(data[0, 1], numpy.inf)
        write_srf(self.x.matlab / self.id / mat, data, [v + 1 for v in ROI], 'double', labels)
        frozen = web_cli_outcome.outcome(self.x.report())
        self.x.write()
        self.assertIn('/summary/exactRuns: expected 1, found 2', self.check(frozen))
        frozen = web_cli_outcome.outcome(self.x.report())
        frozen['matlab']['cpu'] = 'Intel(R) Xeon(R) Platinum 8573C'
        self.assertEqual(self.check(frozen), ['/matlab/cpu: expected "Intel(R) Xeon(R) Platinum 8573C", found "AMD EPYC 9V74 80-Core Processor"'])


class CommandLine(Base):
    ids = list(PLAN)

    def test_gifti_only_difference_is_reported_without_failing(self):
        self.x.plan = cli_plan.plan()
        plan = self.x.root / 'plan.json'
        manifest = self.x.root / 'manifest.json'
        plan.write_text(json.dumps(self.x.plan))
        manifest.write_text(json.dumps(self.x.manifest))
        self.x.plan_sha = sha(plan.read_bytes())
        self.x.write()
        for changed in (False, True):
            with self.subTest(gifti_changed=changed):
                if changed:
                    values = self.x.maps[self.id][0].astype('<f4')
                    values[ROI[0]] = numpy.nextafter(values[ROI[0]], numpy.float32(numpy.inf))
                    write_gifti(self.x.web / self.id / self.names[0], values)
                report = self.x.root / f'report-{changed}.json'
                result = subprocess.run([
                    sys.executable, str(Path(web_cli.__file__).resolve()),
                    str(plan), str(manifest), str(self.x.web), str(self.x.matlab), str(report),
                    '--expect', 'source', '--allow-unattested-source-inputs',
                ], capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                run = json.loads(report.read_text())['runs'][0]
                self.assertEqual(run['class'], 'differs' if changed else 'exact')
                self.assertTrue(run['maps'][0]['srfData']['exact'])
                self.assertEqual(run['maps'][0]['gifti']['exact'], not changed)
                if changed:
                    self.assertIn('raw=exact', result.stdout)
                    self.assertIn('gifti=1', result.stdout)


class Ulp(unittest.TestCase):
    def test_signed_zeros_are_one_ordinal_and_small_values_cross_zero_by_ulps(self):
        for dtype in ('<f4', '<f8'):
            tiny = numpy.finfo(dtype).smallest_subnormal
            zeros = web_cli.difference(numpy.array([0.0], dtype), numpy.array([-0.0], dtype))
            self.assertEqual((zeros['maxUlp'], zeros['signedZeroOnly']), (0, 1), dtype)
            crossing = web_cli.difference(numpy.array([-tiny], dtype), numpy.array([tiny], dtype))
            self.assertEqual((crossing['maxUlp'], crossing['signedZeroOnly']), (2, 0), dtype)
            to_zero = web_cli.difference(numpy.array([-tiny], dtype), numpy.array([0.0], dtype))
            self.assertEqual(to_zero['maxUlp'], 1, dtype)
            negative = numpy.array([-1.0], dtype)
            step = web_cli.difference(negative, numpy.nextafter(negative, numpy.array(0, dtype)))
            self.assertEqual(step['maxUlp'], 1, dtype)
            largest = numpy.finfo(dtype).max
            extreme = web_cli.difference(numpy.array([-largest], dtype), numpy.array([largest], dtype))
            bits = numpy.dtype(dtype).itemsize * 8
            self.assertEqual(extreme['maxUlp'], 2 * (2 ** (bits - 1) - 2 ** numpy.finfo(dtype).nmant - 1), dtype)


class Statuses(Base):
    ids = ['rc_gaussian_lh_single', 'prf_custom_hrf_lh_double']

    def test_expected_refusal_is_listed_and_not_agreement(self):
        report = self.x.report()
        self.assertEqual(self.run_class(report), 'refused')
        self.assertEqual(report['summary']['exactRuns'], 1)

    def test_matlab_failure_is_kept_when_the_web_refuses(self):
        self.x.receipt['rc_gaussian_lh_single'] = 'failed'
        self.x.write()
        report = self.x.report()
        self.assertEqual(self.run_class(report), 'failed')
        self.assertEqual(report['summary']['failedRuns'], 1)
        self.assertEqual(report['summary']['matlabFailedRuns'], 1)

    def test_unexpected_web_statuses_fail(self):
        for status in ('unsupported', 'failed'):
            self.x.status['rc_gaussian_lh_single'] = status
            self.x.write()
            report = self.x.report()
            self.assertEqual(self.run_class(report), 'failed', status)
            self.assertEqual(report['summary']['webUnexpectedRuns'], 1, status)
        self.x.status['rc_gaussian_lh_single'] = 'refused'
        self.x.status['prf_custom_hrf_lh_double'] = 'unsupported'
        self.x.write()
        self.assertEqual(self.x.report()['runs'][1]['class'], 'failed')


class BrowserStatuses(Base):
    ids = ['prf_custom_hrf_lh_double']
    runner = 'browser'

    def test_browser_subject_hrf_is_unsupported_and_matlab_failure_still_fails(self):
        self.assertEqual(self.run_class(), 'unsupported')
        self.x.receipt[self.id] = 'failed'
        self.x.write()
        self.assertEqual(self.run_class(), 'failed')


class InventoryErrors(Base):
    def assertInventory(self):
        run = self.x.report()['runs'][0]
        self.assertEqual(run['class'], 'inventory-error', run.get('error'))
        return run['error']

    def rewrite_srf(self, roi, rows=None, vertices=VERTICES):
        mat, labels, _ = compare_cli.expected_results(PLAN[self.id])
        data = self.x.maps[self.id][:, ROI].T if rows is None else rows
        write_srf(self.x.matlab / self.id / mat, data, roi, 'double', labels, vertices=vertices)

    def test_maps_f64_extra_byte_and_hash(self):
        with (self.x.web / self.id / 'maps.f64').open('ab') as handle:
            handle.write(b'X')
        self.assertIn('bytes', self.assertInventory())
        self.x.write()
        self.x.edit_record(self.id, mapsSha256='0' * 64)
        self.assertIn('hash', self.assertInventory())

    def test_duplicate_zero_out_of_range_and_fractional_roi(self):
        row = self.x.maps[self.id][:, ROI[0]]
        for roi in ([ROI[0] + 1] * 3, [0, 4, 5], [2, 4, VERTICES + 1], [2.5, 4, 5]):
            self.rewrite_srf(roi, numpy.tile(row, (3, 1)))
            # The web side names the same vertices, so only the ROI check itself can refuse.
            self.x.edit_record(self.id, roi=[int(v) - 1 for v in roi])
            self.assertIn('unique integers in 1..vertices', self.assertInventory(), roi)

    def test_web_roi_must_equal_matlab_roi_in_order(self):
        self.x.edit_record(self.id, roi=[ROI[1], ROI[0], ROI[2]])
        self.assertIn('ROI', self.assertInventory())

    def test_roi_requires_a_numeric_matlab_class(self):
        mat = compare_cli.expected_results(PLAN[self.id])[0]
        with h5py.File(self.x.matlab / self.id / mat, 'r+') as handle:
            handle['Srf/Roi'].attrs['MATLAB_class'] = numpy.bytes_('char')
        self.assertIn('Srf.Roi', self.assertInventory())

    def test_gifti_declared_array_count_is_an_exact_integer(self):
        for declared in ('2.5', '2', '-1'):
            with self.subTest(declared=declared):
                self.x.write()
                path = self.x.matlab / self.id / self.names[0]
                path.write_text(path.read_text().replace('<GIFTI>', f'<GIFTI NumberOfDataArrays="{declared}">'))
                self.assertIn('NumberOfDataArrays', self.assertInventory())

    def test_empty_or_one_vertex_gifti_on_both_sides(self):
        for values in (numpy.array([]), numpy.array([5.0])):
            for root in (self.x.web, self.x.matlab):
                for name in self.names:
                    write_gifti(root / self.id / name, values)
            self.assertIn('vertices', self.assertInventory())

    def test_surface_vertex_count_must_match_the_web(self):
        self.rewrite_srf([v + 1 for v in ROI], vertices=VERTICES + 1)
        self.assertIn('vertices', self.assertInventory())

    def test_corrupt_web_only_map_and_extra_web_file(self):
        stem = compare_cli.expected_results(PLAN[self.id])[0][:-4]
        (self.x.web / self.id / f'{stem}_pol.gii').write_text('not even XML')
        self.assertIn('unreadable', self.assertInventory())
        self.x.write()
        (self.x.web / self.id / 'extra.gii').write_text('')
        self.assertIn('record', self.assertInventory())

    def test_missing_and_unexpected_matlab_files(self):
        (self.x.matlab / self.id / self.names[4]).unlink()
        self.assertIn('missing', self.assertInventory())
        self.x.write()
        (self.x.matlab / self.id / 'surprise.gii').write_text('')
        self.assertIn('unexpected', self.assertInventory())
        self.x.write()
        (self.x.matlab / self.id / 'src_x.mat').write_bytes(b'')
        self.assertEqual(self.x.report()['runs'][0]['notCompared']['matlabOnly'], ['src_x.mat'])


class Provenance(Base):
    def test_source_inputs_must_be_explicitly_unattested(self):
        with self.assertRaisesRegex(Inventory, 'unattested'):
            self.x.report(allow=False)

    def test_source_receipts_are_not_a_compiled_execution(self):
        with self.assertRaisesRegex(Inventory, 'expected a compiled-runtime execution'):
            self.x.report(expect='compiled-runtime')

    def test_stale_plan_and_bundle_hashes_are_refused(self):
        self.x.plan_sha = '0' * 64
        with self.assertRaisesRegex(Inventory, 'another plan'):
            self.x.report()
        self.x.plan_sha = sha(json.dumps(self.x.plan).encode())
        self.x.manifest_sha = '0' * 64
        with self.assertRaisesRegex(Inventory, 'another bundle'):
            self.x.report()

    def test_a_changed_model_is_not_the_bundle_model(self):
        self.x.plan['runs'][0]['model']['TR'] = 999
        with self.assertRaisesRegex(Inventory, 'bundle manifest model'):
            self.x.report()

    def test_receipt_argv_kind_and_inventory(self):
        receipt = self.x.matlab / 'receipts' / f'{self.id}.json'
        content = json.loads(receipt.read_text())
        receipt.write_text(json.dumps({**content, 'argv': content['argv'][:-1] + ['-aver=0']}))
        with self.assertRaisesRegex(Inventory, 'argv'):
            self.x.report()
        receipt.write_text(json.dumps({**content, 'execution': 'compiled-runtime'}))
        with self.assertRaisesRegex(Inventory, 'execution kind'):
            self.x.report()
        receipt.write_text(json.dumps(content))
        (self.x.matlab / 'receipts' / 'other.json').write_text('{}')
        with self.assertRaisesRegex(Inventory, 'receipts do not match'):
            self.x.report()

    def test_empty_and_duplicate_plans(self):
        for runs in ([], [self.x.plan['runs'][0]] * 2):
            self.x.plan = {'runs': runs}
            with self.assertRaises(Inventory):
                self.x.report()

    def test_web_output_must_match_the_plan(self):
        (self.x.web / 'stray').mkdir()
        with self.assertRaisesRegex(Inventory, 'web output'):
            self.x.report()


class Compiled(Base):
    kind = 'compiled-runtime'

    def test_compiled_receipts_name_the_image_and_attest_inputs(self):
        report = self.x.report()
        self.assertEqual(self.run_class(report), 'exact')
        self.assertEqual(report['matlab']['image']['id'], IMAGE)
        self.assertEqual(report['matlab']['inputs'], 'attested by receipts/inputs.json')
        with self.assertRaisesRegex(Inventory, 'expected a source execution'):
            self.x.report(expect='source')

    def test_malformed_compiled_receipts_are_refused(self):
        environment = self.x.matlab / 'receipts' / 'environment.json'
        content = json.loads(environment.read_text())
        environment.write_text(json.dumps({**content, 'image': {'id': 'samsrf-reference:latest'}}))
        with self.assertRaisesRegex(Inventory, 'image ID'):
            self.x.report()
        environment.write_text(json.dumps(content))
        inputs = self.x.matlab / 'receipts' / 'inputs.json'
        inputs.write_text(json.dumps({'sha256': {**self.x.manifest, 'extra': 'd' * 64}, 'unchanged': True}))
        with self.assertRaisesRegex(Inventory, 'other inputs'):
            self.x.report()
        inputs.unlink()
        with self.assertRaisesRegex(Inventory, 'no inputs.json'):
            self.x.report()
        environment.write_text(json.dumps({'execution': 'something-else'}))
        with self.assertRaisesRegex(Inventory, 'neither'):
            self.x.report()


if __name__ == '__main__':
    unittest.main()
