"""compare_ui_cli.py and run_ui_matrix.mjs, with negative controls."""

import itertools
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import zipfile

import numpy

import cli_plan
import compare_cli
import compare_ui_cli as ui_cli
from compare_web_cli import Inventory
from test_cli import scratch, write_gifti
from test_web_cli import IMAGE, PLAN, ROI, VERTICES, Fixture, sha

HERE = Path(__file__).resolve().parent
LAYERS = "Cannot read properties of undefined (reading 'layers')"


class UiFixture(Fixture):
    """A compiled MATLAB execution, the engine harness's run (self.web) and the production
    UI's records, saved models and downloads of the same runs."""

    def __init__(self, root, ids, ui_status=None):
        self.ui_status = dict(ui_status or {})
        self.reports = itertools.count()
        super().__init__(root, ids, kind='compiled', runner='browser')
        self.ui = self.root / 'ui'
        self.write_ui()

    def write_ui(self, gifti=None):
        """The UI root. `gifti` replaces (run, file) values in the download and in the engine's file."""
        if self.ui.exists():
            shutil.rmtree(self.ui)
        self.ui.mkdir()
        (self.ui / 'environment.json').write_text(json.dumps({
            'runner': 'production-ui', 'planSha256': self.plan_sha, 'bundleSha256': self.manifest_sha,
            'wasmSha256': 'c' * 64}))
        (self.ui / 'runs.json').write_text('[]')
        for run in self.plan['runs']:
            run_id = run['id']
            expected = ui_cli.expected_ui_outcome(run)
            status = self.ui_status.get(run_id, expected['status'])
            record = {'id': run_id, 'status': status, 'pageErrors': []}
            directory = self.ui / run_id
            if status in ('succeeded', 'succeeded-ui-error', 'unsupported'):
                directory.mkdir()
                model = (json.dumps(ui_cli.expected_app_model(run), indent=4) + '\n').encode()
                (directory / 'app-model.json').write_bytes(model)
                record['appModelSha256'] = sha(model)
            if status in ('succeeded', 'succeeded-ui-error'):
                mat, _, names = compare_cli.expected_results(run)
                stem = mat[:-4]
                staged = self.root / 'staged' / run_id
                staged.mkdir(parents=True, exist_ok=True)
                archive = directory / f'{stem}_maps.zip'
                with zipfile.ZipFile(archive, 'w') as handle:
                    for index, name in enumerate([*names, f'{stem}_pol.gii', f'{stem}_ecc.gii']):
                        values = (gifti or {}).get((run_id, name), self.maps[run_id][min(index, len(names) - 1)])
                        write_gifti(staged / name, values)
                        if (self.web / run_id / name).exists():
                            shutil.copyfile(staged / name, self.web / run_id / name)
                        handle.write(staged / name, name)
                record.update({'zip': archive.name, 'zipSha256': sha(archive.read_bytes()),
                               'statusText': {'prf': 'pRF maps ready', 'rc': 'Reverse-correlation maps ready',
                                              'cf': 'Connective field maps ready'}[run['algorithm']] + ' (1.0 s)'})
                if status == 'succeeded-ui-error':
                    record['uiError'] = LAYERS
            if status == expected['status'] and status in ('refused', 'unsupported'):
                record['stage'] = expected['stage']
                record[ui_cli.MESSAGE_FIELD[expected['stage']]] = expected['message']
            (self.ui / f'{run_id}.ui.json').write_text(json.dumps(record))

    def ui_report(self, expect='compiled-runtime'):
        return ui_cli.compare(self.plan, self.plan_sha, self.manifest, self.manifest_sha, self.ui, self.matlab,
                              self.web, expect, self.root / f'extracted-{next(self.reports)}')

    def edit_ui(self, run_id, **changes):
        path = self.ui / f'{run_id}.ui.json'
        record = json.loads(path.read_text())
        record.update(changes)
        path.write_text(json.dumps(record))

    def edit_json(self, path, **changes):
        content = json.loads(path.read_text())
        content.update(changes)
        path.write_text(json.dumps(content))


class Base(unittest.TestCase):
    ids = ['rc_hull_lh_single']
    ui_status = {}

    def setUp(self):
        self._scratch = scratch()
        self.x = UiFixture(self._scratch.name, self.ids, self.ui_status)
        self.id = self.ids[0]
        self.names = compare_cli.expected_results(PLAN[self.id])[2]

    def tearDown(self):
        self._scratch.cleanup()

    def run_report(self):
        return self.x.ui_report()['runs'][0]


class Values(Base):
    def test_identical_downloads_are_exact_and_equal_the_engine_files(self):
        report = self.x.ui_report()
        run = report['runs'][0]
        self.assertEqual(run['class'], 'exact')
        self.assertEqual(report['matlab']['image']['id'], IMAGE)
        self.assertTrue(ui_cli.engine_equal(run['engineFiles']))
        self.assertEqual(report['summary']['engineFilesEqual'], len(self.names) + 2)
        self.assertEqual(report['summary']['completedRuns'], 1)
        self.assertEqual(report['failures'], [])
        self.assertFalse(report['plan']['canonical'])

    def test_one_float32_ulp_differs_in_both_comparisons_and_is_not_a_failure(self):
        values = self.x.maps[self.id][1].astype('<f4')
        values[ROI[0]] = numpy.nextafter(values[ROI[0]], numpy.float32(numpy.inf))
        self.x.write_ui({(self.id, self.names[1]): values})
        report = self.x.ui_report()
        entry = report['runs'][0]['maps'][1]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['gifti']['differing'], 1)
        self.assertEqual(entry['srfDataCast']['differing'], 1)
        self.assertEqual(report['runs'][0]['class'], 'differs')
        self.assertEqual(report['failures'], [])

    def test_srf_data_disagreeing_with_matlabs_own_gifti_differs(self):
        values = self.x.maps[self.id][1].astype('<f4')
        values[ROI[0]] = numpy.nextafter(values[ROI[0]], numpy.float32(numpy.inf))
        write_gifti(self.x.matlab / self.id / self.names[1], values)
        self.x.write_ui({(self.id, self.names[1]): values})
        entry = self.run_report()['maps'][1]
        self.assertTrue(entry['gifti']['exact'])
        self.assertEqual(entry['srfDataCast']['differing'], 1)
        self.assertEqual(entry['class'], 'differs')

    def test_nan_sign_bits_differ_and_are_named(self):
        self.x.maps[self.id][2][ROI[1]] = numpy.nan
        self.x.write()
        values = self.x.maps[self.id][2].astype('<f4')
        values[ROI[1]] = -values[ROI[1]]
        self.x.write_ui({(self.id, self.names[2]): values})
        entry = self.run_report()['maps'][2]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['gifti']['nanSignOnly'], 1)
        self.assertEqual(entry['gifti']['maxUlp'], 0)


class DoublePrecision(Base):
    ids = ['rc_hull_lh_double']

    def test_double_values_beyond_float32_are_not_observable_and_say_so(self):
        self.x.maps[self.id][1][ROI[0]] = numpy.nextafter(self.x.maps[self.id][1][ROI[0]], numpy.inf)
        self.x.write()
        self.x.write_ui()
        entry = self.run_report()['maps'][1]
        self.assertEqual(entry['srfDataPrecision'], 'double')
        self.assertTrue(entry['srfDataCast']['exact'])


class EngineGate(Base):
    def test_a_changed_engine_export_fails_the_gate_and_keeps_the_class(self):
        engine = self.x.web / self.id / self.names[0]
        engine.write_bytes(engine.read_bytes() + b' ')
        report = self.x.ui_report()
        run = report['runs'][0]
        self.assertEqual(run['class'], 'exact')
        self.assertEqual(run['engineFiles']['differ'], [self.names[0]])
        self.assertEqual(report['summary']['engineMismatchRuns'], 1)
        self.assertIn('engine harness export', ' '.join(report['failures']))

    def test_files_the_engine_did_not_export_fail_the_gate(self):
        stem = compare_cli.expected_results(PLAN[self.id])[0][:-4]
        (self.x.web / self.id / f'{stem}_pol.gii').unlink()
        self.x.edit_json(self.x.web / f'{self.id}.web.json',
                         files=[name for name in json.loads((self.x.web / f'{self.id}.web.json').read_text())['files']
                                if name != f'{stem}_pol.gii'])
        run = self.run_report()
        self.assertEqual(run['engineFiles']['onlyDownloaded'], [f'{stem}_pol.gii'])
        self.assertFalse(ui_cli.engine_equal(run['engineFiles']))

    def test_an_engine_run_without_a_result_fails_the_gate(self):
        self.x.status[self.id] = 'failed'
        self.x.write()
        self.x.write_ui()
        report = self.x.ui_report()
        self.assertEqual(report['runs'][0]['engineFiles']['engineStatus'], 'failed')
        self.assertEqual(report['summary']['engineMismatchRuns'], 1)


class Statuses(Base):
    ids = ['rc_hull_lh_single', 'rc_gaussian_lh_single', 'prf_custom_hrf_lh_double']

    def classes(self, report=None):
        return {run['id']: run['class'] for run in (report or self.x.ui_report())['runs']}

    def test_expected_refusal_is_listed_not_agreement_and_a_subject_hrf_run_completes(self):
        report = self.x.ui_report()
        self.assertEqual(self.classes(report), {'rc_hull_lh_single': 'exact', 'rc_gaussian_lh_single': 'refused',
                                                'prf_custom_hrf_lh_double': 'exact'})
        self.assertEqual(report['summary']['completedRuns'], 2)
        self.assertEqual(report['summary']['unsupportedRuns'], 0)
        self.assertEqual(report['failures'], [])

    def test_ui_error_after_a_result_is_compared_but_is_not_a_completed_workflow(self):
        self.x.ui_status['rc_hull_lh_single'] = 'succeeded-ui-error'
        self.x.write_ui()
        report = self.x.ui_report()
        run = report['runs'][0]
        self.assertEqual(run['class'], 'ui-error')
        self.assertEqual(run['downloads'], 'exact')
        self.assertEqual(run['uiError'], LAYERS)
        self.assertEqual((report['summary']['completedRuns'], report['summary']['exactDownloadRuns']), (1, 2))
        self.assertIn('did not complete', ' '.join(report['failures']))

    def test_a_page_error_makes_a_result_ui_error_and_a_refusal_failed(self):
        for run_id, expected in (('rc_hull_lh_single', 'ui-error'), ('prf_custom_hrf_lh_double', 'ui-error'),
                                 ('rc_gaussian_lh_single', 'failed')):
            with self.subTest(run=run_id):
                self.x.write_ui()
                self.x.edit_ui(run_id, pageErrors=['Uncaught TypeError'])
                self.assertEqual(self.classes()[run_id], expected)

    def test_refusals_count_only_with_the_exact_expected_text_and_nothing_offered(self):
        for run_id, change in (('rc_gaussian_lh_single', {'message': 'The model JSON is not valid: Unexpected end of JSON input'}),
                               ('rc_gaussian_lh_single', {'message': 'Fit_pRF 2 is not supported by this port'})):
            with self.subTest(run=run_id, change=change):
                self.x.write_ui()
                self.x.edit_ui(run_id, **change)
                self.assertEqual(self.classes()[run_id], 'failed')
        self.x.write_ui()
        directory = self.x.ui / 'rc_gaussian_lh_single'
        directory.mkdir()
        shutil.copyfile(next((self.x.ui / 'rc_hull_lh_single').glob('*.zip')), directory / 'maps.zip')
        self.x.edit_ui('rc_gaussian_lh_single', zip='maps.zip', zipSha256=sha((directory / 'maps.zip').read_bytes()))
        self.assertEqual(self.classes()['rc_gaussian_lh_single'], 'failed')

    def test_the_former_subject_hrf_refusal_is_a_failure(self):
        self.x.ui_status = {'prf_custom_hrf_lh_double': 'unsupported'}
        self.x.write_ui()
        self.x.edit_ui('prf_custom_hrf_lh_double', stage='run', runMessage='model: Hrf hrf_custom is an old-school HRF fit file: the caller must load its fP and call hrf::old_school')
        self.assertEqual(self.classes()['prf_custom_hrf_lh_double'], 'failed')

    def test_unexpected_statuses_fail(self):
        for run_id, status in (('rc_hull_lh_single', 'refused'), ('rc_hull_lh_single', 'failed'),
                               ('rc_hull_lh_single', 'unsupported'),
                               ('rc_gaussian_lh_single', 'succeeded'), ('prf_custom_hrf_lh_double', 'unsupported')):
            with self.subTest(run=run_id, status=status):
                self.x.ui_status = {run_id: status}
                self.x.write_ui()
                self.assertEqual(self.classes()[run_id], 'failed')

    def test_matlab_failure_fails_even_when_the_ui_refuses(self):
        self.x.receipt['rc_gaussian_lh_single'] = 'failed'
        self.x.write()
        self.x.write_ui()
        self.assertEqual(self.classes()['rc_gaussian_lh_single'], 'failed')


class InventoryErrors(Base):
    def assertInventory(self, message):
        run = self.run_report()
        self.assertEqual(run['class'], 'inventory-error', run)
        self.assertIn(message, run['error'])

    def rewrite_zip(self, change):
        archive = next((self.x.ui / self.id).glob('*.zip'))
        with zipfile.ZipFile(archive) as handle:
            entries = {name: handle.read(name) for name in handle.namelist()}
        change(entries)
        with zipfile.ZipFile(archive, 'w') as handle:
            for name, data in entries.items():
                handle.writestr(name, data)
        self.x.edit_ui(self.id, zipSha256=sha(archive.read_bytes()))

    def test_zip_hash_must_match_the_record(self):
        for value in ('0' * 64, 'A' * 64):
            with self.subTest(value=value):
                self.x.write_ui()
                self.x.edit_ui(self.id, zipSha256=value)
                self.assertInventory('hash its record names')

    def test_missing_contract_map_and_unexpected_file(self):
        stem = compare_cli.expected_results(PLAN[self.id])[0][:-4]
        for change in (lambda entries: entries.pop(self.names[0]),
                       lambda entries: entries.pop(f'{stem}_ecc.gii'),
                       lambda entries: entries.update({'../extra.gii': entries[self.names[0]]})):
            with self.subTest(change=change):
                self.x.write_ui()
                self.rewrite_zip(change)
                self.assertInventory('polar angle and eccentricity maps')
        self.assertEqual(list(self.x.root.rglob('extra.gii')), [])

    def test_download_must_cover_every_vertex(self):
        self.x.write_ui({(self.id, self.names[0]): numpy.zeros(VERTICES - 1, '<f4')})
        self.assertInventory('vertices')

    def test_run_directory_must_hold_exactly_what_its_record_names(self):
        (self.x.ui / self.id / 'stray.gii').write_bytes(b'')
        self.assertInventory("['stray.gii']")
        self.x.write_ui()
        (self.x.ui / self.id / 'app-model.json').unlink()
        self.assertInventory("['app-model.json']")
        self.x.write_ui()
        path = self.x.ui / f'{self.id}.ui.json'
        record = json.loads(path.read_text())
        del record['appModelSha256']
        path.write_text(json.dumps(record))
        self.assertInventory("names no ['appModelSha256']")

    def test_saved_model_must_hash_to_its_record_and_be_the_plan_model(self):
        path = self.x.ui / self.id / 'app-model.json'
        path.write_bytes(path.read_bytes() + b' ')
        self.assertInventory('hash its record names')
        for change in ({'TR': 2}, {'Allow_Negative_Peaks': 0}, {'Data_Precision': 'double'},
                       {'Aperture_File': 'aps_bars_vec'}):
            with self.subTest(change=change):
                self.x.write_ui()
                path.write_text(json.dumps({**json.loads(path.read_text()), **change}, indent=4) + '\n')
                self.x.edit_ui(self.id, appModelSha256=sha(path.read_bytes()))
                self.assertInventory('not the plan model')
        self.x.write_ui()
        self.x.edit_ui(self.id, appModelSha256=sha(path.read_bytes()).upper())
        self.assertInventory('hash its record names')

    def test_matlab_outputs_must_be_complete_and_expected(self):
        (self.x.matlab / self.id / 'unexpected.bin').write_bytes(b'')
        self.assertInventory('unexpected MATLAB files')
        self.x.write()
        self.x.write_ui()
        (self.x.matlab / self.id / self.names[3]).unlink()
        self.assertInventory('missing MATLAB results')
        self.x.write()
        self.x.write_ui()
        (self.x.matlab / self.id / 'reg_aps_bars.mat').write_bytes(b'')
        self.assertEqual(self.run_report()['notCompared']['matlabOnly'], ['reg_aps_bars.mat'])

    def test_engine_run_directory_must_match_its_record(self):
        (self.x.web / self.id / 'stray.gii').write_bytes(b'')
        self.assertInventory('web run directory differs from its record')


class Provenance(Base):
    def environment(self, root, **changes):
        self.x.edit_json(root / 'environment.json', **changes)

    def test_compiled_receipts_and_matching_plan_are_required(self):
        with self.assertRaisesRegex(Inventory, 'expected a source execution'):
            self.x.ui_report(expect='source')
        for key, value in (('planSha256', 'd' * 64), ('bundleSha256', 'd' * 64), ('runner', 'browser')):
            with self.subTest(key=key):
                self.x.write_ui()
                self.environment(self.x.ui, **{key: value})
                with self.assertRaises(Inventory):
                    self.x.ui_report()

    def test_served_module_must_be_a_sha256_and_the_engine_module(self):
        for value, message in (('z' * 64, 'no served WebAssembly hash'), ('c' * 64 + '\n', 'no served WebAssembly hash'),
                               (None, 'no served WebAssembly hash'), ('e' * 64, 'another WebAssembly module')):
            with self.subTest(value=value):
                self.x.write_ui()
                self.environment(self.x.ui, wasmSha256=value)
                with self.assertRaisesRegex(Inventory, message):
                    self.x.ui_report()
        self.x.write_ui()
        self.environment(self.x.ui, wasmSha256='Z' * 64)
        self.environment(self.x.web, wasmSha256='Z' * 64)
        with self.assertRaisesRegex(Inventory, 'WebAssembly hash'):
            self.x.ui_report()

    def test_engine_root_must_be_a_run_of_this_plan_and_bundle(self):
        for key, value, message in (('planSha256', '0' * 64, 'another plan'), ('bundleSha256', '0' * 64, 'another bundle'),
                                    ('runner', 'production-ui', 'no runner'), ('wasmSha256', 'C' * 64, 'WebAssembly hash')):
            with self.subTest(key=key):
                self.x.write()
                self.x.write_ui()
                self.environment(self.x.web, **{key: value})
                with self.assertRaisesRegex(Inventory, message):
                    self.x.ui_report()
        self.x.write()
        self.x.write_ui()
        (self.x.web / 'stray').mkdir()
        with self.assertRaisesRegex(Inventory, 'web output does not match the plan'):
            self.x.ui_report()

    def test_ui_root_must_hold_exactly_the_plan_records(self):
        for change in (lambda: (self.x.ui / 'unexpected.ui.json').write_text('{}'),
                       lambda: (self.x.ui / 'runs.json').unlink(),
                       lambda: (self.x.ui / 'stray').mkdir()):
            with self.subTest(change=change):
                self.x.write_ui()
                change()
                with self.assertRaisesRegex(Inventory, 'UI output does not match the plan'):
                    self.x.ui_report()

    def test_record_identity_and_status_must_be_valid(self):
        for change in ({'id': 'another_run'}, {'status': 'exact'}):
            with self.subTest(change=change):
                self.x.write_ui()
                self.x.edit_ui(self.id, **change)
                with self.assertRaises(Inventory):
                    self.x.ui_report()


class CommandLine(unittest.TestCase):
    """The public entry on the whole matrix: exit 0 agrees, 1 fails, 2 refuses."""

    def setUp(self):
        self._scratch = scratch()
        self.x = UiFixture(self._scratch.name, list(PLAN))
        self.x.plan = cli_plan.plan()
        self.plan = self.x.root / 'plan.json'
        self.manifest = self.x.root / 'manifest.json'
        self.plan.write_text(json.dumps(self.x.plan))
        self.manifest.write_text(json.dumps(self.x.manifest))
        self.x.plan_sha = sha(self.plan.read_bytes())
        self.x.manifest_sha = sha(self.manifest.read_bytes())
        self.reports = itertools.count()
        self.x.write()
        self.x.write_ui()

    def tearDown(self):
        self._scratch.cleanup()

    def cli(self, report=None):
        report = report or self.x.root / f'report-{next(self.reports)}.json'
        result = subprocess.run([sys.executable, str(HERE / 'compare_ui_cli.py'), str(self.plan),
                                 str(self.manifest), str(self.x.ui), str(self.x.matlab), str(report),
                                 '--expect', 'compiled-runtime', '--engine-root', str(self.x.web)],
                                capture_output=True, text=True, check=False)
        return result, json.loads(report.read_text()) if report.exists() else None

    def test_exit_codes_on_the_whole_matrix(self):
        result, report = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((report['summary']['completedRuns'], report['summary']['refusedRuns'],
                          report['summary']['unsupportedRuns']), (22, 2, 0))
        self.assertTrue(report['plan']['canonical'])
        run_id = 'rc_hull_lh_single'
        names = compare_cli.expected_results(PLAN[run_id])[2]
        values = self.x.maps[run_id][1].astype('<f4')
        values[ROI[0]] = numpy.nextafter(values[ROI[0]], numpy.float32(numpy.inf))
        self.x.write_ui({(run_id, names[1]): values})
        result, report = self.cli()
        self.assertEqual(result.returncode, 0, 'a MATLAB numerical difference is reported, not gated')
        self.assertEqual(report['summary']['differsRuns'], 1)
        self.x.write()
        self.x.write_ui()
        engine = self.x.web / run_id / names[0]
        engine.write_bytes(engine.read_bytes() + b' ')
        result, _ = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn('engine harness export', result.stderr)
        self.x.write()
        self.x.ui_status = {run_id: 'succeeded-ui-error'}
        self.x.write_ui()
        result, _ = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn('did not complete', result.stderr)
        self.x.ui_status = {}
        self.x.write_ui()
        self.x.edit_ui(run_id, zipSha256='0' * 64)
        self.assertEqual(self.cli()[0].returncode, 1)
        self.x.write_ui()
        self.x.edit_json(self.x.ui / 'environment.json', wasmSha256='z' * 64)
        result, report = self.cli()
        self.assertEqual((result.returncode, report), (2, None))
        self.x.write_ui()
        existing = self.x.root / 'existing.json'
        existing.write_text('{}')
        self.assertEqual(self.cli(report=existing)[0].returncode, 2)
        self.assertEqual(existing.read_text(), '{}')

    def test_success_label_cannot_hide_errors_or_missing_completion_text(self):
        run_id = 'rc_hull_lh_single'
        for change in ({'uiError': LAYERS}, {'statusText': None}, {'statusText': ''},
                       {'statusText': LAYERS}, {'statusText': 42}, {'statusText': 'pRF maps ready (1.0 s)'},
                       {'statusText': 'Error: Reverse-correlation maps ready (1.0 s)'}):
            with self.subTest(change=change):
                self.x.write_ui()
                self.x.edit_ui(run_id, **change)
                result, report = self.cli()
                self.assertEqual(result.returncode, 1, result.stderr)
                run = next(run for run in report['runs'] if run['id'] == run_id)
                self.assertEqual((run['class'], run['downloads']), ('ui-error', 'exact'))
                self.assertEqual(report['summary']['completedRuns'], 21)

    def test_ui_error_invalidates_an_otherwise_expected_refusal(self):
        for run_id in ('rc_gaussian_lh_single', 'cf_gaussian_lh_single'):
            with self.subTest(run=run_id):
                self.x.write_ui()
                self.x.edit_ui(run_id, uiError=LAYERS)
                result, report = self.cli()
                self.assertEqual(result.returncode, 1, result.stderr)
                run = next(run for run in report['runs'] if run['id'] == run_id)
                self.assertEqual(run['class'], 'failed')

    def test_refused_routes_still_require_complete_matlab_outputs(self):
        for run_id in ('rc_gaussian_lh_single', 'cf_gaussian_lh_single'):
            for mutation in ('missing', 'extra'):
                with self.subTest(run=run_id, mutation=mutation):
                    self.x.write()
                    if mutation == 'missing':
                        name = compare_cli.expected_results(PLAN[run_id])[2][0]
                        (self.x.matlab / run_id / name).unlink()
                    else:
                        (self.x.matlab / run_id / 'unexpected.bin').write_bytes(b'extra')
                    result, report = self.cli()
                    self.assertEqual(result.returncode, 1, result.stderr)
                    run = next(run for run in report['runs'] if run['id'] == run_id)
                    self.assertEqual(run['class'], 'inventory-error')
                    self.assertIn('MATLAB', run['error'])

    def test_a_consistent_subset_of_the_matrix_is_refused(self):
        root = self.x.root / 'subset'
        root.mkdir()
        subset = UiFixture(root, ['rc_hull_lh_single'])
        subset.plan = {**cli_plan.plan(), 'runs': [PLAN['rc_hull_lh_single']]}
        plan = root / 'plan.json'
        manifest = root / 'manifest.json'
        plan.write_text(json.dumps(subset.plan))
        manifest.write_text(json.dumps(subset.manifest))
        subset.plan_sha = sha(plan.read_bytes())
        subset.manifest_sha = sha(manifest.read_bytes())
        subset.write()
        subset.write_ui()
        self.assertEqual(subset.ui_report()['failures'], [], 'only the whole-matrix rule refuses this subset')
        report = root / 'report.json'
        result = subprocess.run([sys.executable, str(HERE / 'compare_ui_cli.py'), str(plan), str(manifest),
                                 str(subset.ui), str(subset.matlab), str(report), '--expect', 'compiled-runtime',
                                 '--engine-root', str(subset.web)], capture_output=True, text=True, check=False)
        self.assertEqual((result.returncode, report.exists()), (2, False), result.stderr)
        self.assertIn("not cli_plan.py's matrix", result.stderr)


def node(script, *arguments):
    return subprocess.run(['node', '--input-type=module', '-e', script, *arguments],
                          capture_output=True, text=True, check=True).stdout


class RunTranslation(unittest.TestCase):
    """run_ui_matrix.mjs's uiRun and expectedOutcome: what a person gives the app, and what it must do."""

    def translate(self, run, bundle):
        script = ("import { uiRun } from " + json.dumps((HERE / 'run_ui_matrix.mjs').as_uri()) + ";"
                  "const [run, bundle] = JSON.parse(process.argv[1]);"
                  "try { console.log(JSON.stringify(uiRun(run, bundle))); }"
                  "catch (error) { console.log(JSON.stringify({ error: error.message })); }")
        return json.loads(node(script, json.dumps([run, str(bundle)])))

    def setUp(self):
        self._scratch = scratch()
        self.bundle = Path(self._scratch.name)
        for name in ('lh_ubars2.gii', 'lh_ubars1.gii', 'lh_ubars10.gii', 'lh_benson.gii', 'lh_other.gii'):
            (self.bundle / 'x001_lh').mkdir(exist_ok=True)
            (self.bundle / 'x001_lh' / name).write_text('')

    def tearDown(self):
        self._scratch.cleanup()

    def test_forward_and_cf_runs(self):
        prf = self.translate(PLAN['prf_gaussian_lh_concatenate_single'], self.bundle)
        self.assertEqual(prf['algorithm'], 'prf')
        self.assertEqual(prf['combine'], 'concatenate')
        self.assertEqual(prf['model']['Data_Precision'], 'single')
        self.assertEqual([Path(p).name for p in prf['files']['runs']], ['lh_ubars1.gii', 'lh_ubars10.gii', 'lh_ubars2.gii'])
        self.assertEqual([Path(p).name for p in prf['files']['surfaces']], ['lh.white', 'lh.area'])
        self.assertTrue(prf['files']['apertures'][0].endswith('.mat'))
        cf = self.translate(PLAN['cf_hull_lh_double'], self.bundle)
        self.assertEqual(Path(cf['files']['template'][0]).name, 'lh_benson.gii')
        self.assertEqual(Path(cf['files']['seed'][0]).name, 'seed.label')
        self.assertNotIn('apertures', cf['files'])

    def test_unplanned_arguments_are_refused(self):
        run = json.loads(json.dumps(PLAN['rc_hull_lh_single']))
        run['argv'] = [value.replace('-norm=1', '-norm=0') for value in run['argv']]
        self.assertIn('only -norm=1', self.translate(run, self.bundle)['error'])

    def test_expected_outcomes_agree_with_the_comparator(self):
        script = ("import { expectedOutcome } from " + json.dumps((HERE / 'run_ui_matrix.mjs').as_uri()) + ";"
                  "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(expectedOutcome)));")
        runs = cli_plan.plan()['runs']
        outcomes = json.loads(node(script, json.dumps(runs)))
        self.assertEqual(outcomes, [ui_cli.expected_ui_outcome(run) for run in runs])
        self.assertEqual(sorted(outcome['status'] for outcome in outcomes).count('succeeded'), 22)

    def test_a_subject_hrf_run_gives_the_app_its_file(self):
        for run_id in ('prf_custom_hrf_lh_double', 'rc_custom_hrf_lh_single'):
            with self.subTest(run=run_id):
                files = self.translate(PLAN[run_id], self.bundle)['files']
                self.assertEqual(files['subjectHrf'], [str(self.bundle / 'hrf_custom.mat')])
        self.assertNotIn('subjectHrf', self.translate(PLAN['prf_gaussian_lh_concatenate_single'], self.bundle)['files'])


class Runner(unittest.TestCase):
    """run_ui_matrix.mjs's runOne against scripted_ui_page.mjs: how each outcome is recorded."""

    def setUp(self):
        self._scratch = scratch()
        self.root = Path(self._scratch.name)
        self.bundle = self.root / 'bundle'
        for path in ('x001_lh/lh_ubars1.gii', 'x001_lh/lh_ubars2.gii', 'x001_lh/roi.label', 'x001_lh/seed.label',
                     'x001_lh/lh_benson.gii', 'x001_lh/surf/lh.white', 'x001_lh/surf/lh.area',
                     'apertures/aps_bars.mat', 'apertures/aps_bars_vec.mat', 'hrf_custom.mat'):
            (self.bundle / path).parent.mkdir(parents=True, exist_ok=True)
            (self.bundle / path).write_text('')
        self.cases = itertools.count()

    def tearDown(self):
        self._scratch.cleanup()

    def record(self, run_id, **scenario):
        scenario.setdefault('model', f'Model {run_id} loaded from {run_id}.json')
        output = self.root / f'case-{next(self.cases)}'
        result = subprocess.run(['node', str(HERE / 'scripted_ui_page.mjs'), str(HERE / 'run_ui_matrix.mjs'),
                                 str(self.bundle), str(output), json.dumps(PLAN[run_id]), json.dumps(scenario)],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_a_subject_hrf_run_completes_only_with_its_outcome(self):
        record = self.record('prf_custom_hrf_lh_double', outcome='pRF maps ready (1.0 s)', downloadable=True)
        self.assertEqual(record['status'], 'succeeded')
        self.assertEqual(record['files']['subjectHrf'], ['hrf_custom.mat'])
        self.assertIn('zipSha256', record)
        for scenario in ({'outcome': 'model: Hrf hrf_custom is an old-school HRF fit file: the caller must load its fP and call hrf::old_school'}, {'outcome': 'Worker crashed: out of memory'},
                         {'ready': False}):
            with self.subTest(scenario=scenario):
                self.assertEqual(self.record('prf_custom_hrf_lh_double', **scenario)['status'], 'failed')
        self.assertEqual(self.record('rc_custom_hrf_lh_double', outcome='Worker crashed: out of memory')['status'], 'failed')

    def test_only_the_expected_model_refusal_is_refused(self):
        refusal = ui_cli.MODEL_REFUSALS['rc']
        record = self.record('rc_gaussian_lh_single', model=refusal)
        self.assertEqual((record['status'], record['stage'], record['message']), ('refused', 'model', refusal))
        for text in ('The model JSON is not valid: Unexpected end of JSON input', ui_cli.MODEL_REFUSALS['cf']):
            with self.subTest(text=text):
                self.assertEqual(self.record('rc_gaussian_lh_single', model=text)['status'], 'failed')
        self.assertEqual(self.record('rc_hull_lh_single', outcome='Fit_pRF 2 is not supported by this port')['status'],
                         'failed')

    def test_a_result_is_succeeded_only_with_its_outcome_and_no_page_error(self):
        done = 'Reverse-correlation maps ready'
        record = self.record('rc_hull_lh_single', outcome=done, downloadable=True)
        self.assertEqual(record['status'], 'succeeded')
        self.assertIn('zipSha256', record)
        for scenario, error in (({'outcome': LAYERS}, LAYERS), ({'outcome': done, 'pageErrors': ['boom']}, 'boom')):
            with self.subTest(scenario=scenario):
                record = self.record('rc_hull_lh_single', downloadable=True, **scenario)
                self.assertEqual((record['status'], record.get('uiError')), ('succeeded-ui-error', error))
                self.assertIn('zipSha256', record)


if __name__ == '__main__':
    unittest.main()
