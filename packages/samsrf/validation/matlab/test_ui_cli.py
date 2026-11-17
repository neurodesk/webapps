"""compare_ui_cli.py and run_ui_matrix.mjs's run translation, with negative controls."""

import json
from pathlib import Path
import subprocess
import sys
import unittest
import zipfile

import numpy

import compare_cli
import compare_ui_cli as ui_cli
from compare_web_cli import Inventory
from test_cli import scratch, write_gifti
from test_web_cli import IMAGE, PLAN, ROI, VERTICES, Fixture, sha

HERE = Path(__file__).resolve().parent


class UiFixture(Fixture):
    """A compiled MATLAB execution and the production UI's downloads of the same runs."""

    def __init__(self, root, ids, ui_status=None):
        self.ui_status = dict(ui_status or {})
        super().__init__(root, ids, kind='compiled', runner='browser')
        self.ui = self.root / 'ui'
        self.engine = self.root / 'engine'
        self.write_ui()

    def write_ui(self, gifti=None):
        """The UI root, from the web fixture's maps; `gifti` replaces (run, file) values."""
        for path in (getattr(self, 'ui', None), getattr(self, 'engine', None)):
            if path and path.exists():
                for item in sorted(path.rglob('*'), reverse=True):
                    item.unlink() if item.is_file() else item.rmdir()
                path.rmdir()
        self.ui.mkdir()
        (self.ui / 'environment.json').write_text(json.dumps({
            'runner': 'production-ui', 'planSha256': self.plan_sha, 'bundleSha256': self.manifest_sha,
            'wasmSha256': 'c' * 64}))
        for run in self.plan['runs']:
            run_id = run['id']
            status = self.ui_status.get(run_id, self.status[run_id])
            record = {'id': run_id, 'status': status}
            if status in ('succeeded', 'succeeded-ui-error'):
                mat, _, names = compare_cli.expected_results(run)
                stem = mat[:-4]
                files = [*names, f'{stem}_pol.gii', f'{stem}_ecc.gii']
                staged = self.root / 'staged' / run_id
                staged.mkdir(parents=True, exist_ok=True)
                engine = self.engine / run_id
                engine.mkdir(parents=True)
                for index, name in enumerate(files):
                    values = (gifti or {}).get((run_id, name), self.maps[run_id][min(index, len(names) - 1)])
                    write_gifti(staged / name, values)
                    (engine / name).write_bytes((staged / name).read_bytes())
                directory = self.ui / run_id
                directory.mkdir()
                archive = directory / f'{stem}_maps.zip'
                with zipfile.ZipFile(archive, 'w') as handle:
                    for name in files:
                        handle.write(staged / name, name)
                record.update({'zip': archive.name, 'zipSha256': sha(archive.read_bytes())})
                if status == 'succeeded-ui-error':
                    record['uiError'] = "Cannot read properties of undefined (reading 'layers')"
            (self.ui / f'{run_id}.ui.json').write_text(json.dumps(record))

    def ui_report(self, engine=True):
        return ui_cli.compare(self.plan, self.plan_sha, self.manifest, self.manifest_sha, self.ui, self.matlab,
                              'compiled-runtime', engine_root=self.engine if engine else None,
                              scratch=self.root / 'extracted')

    def edit_ui(self, run_id, **changes):
        path = self.ui / f'{run_id}.ui.json'
        record = json.loads(path.read_text())
        record.update(changes)
        path.write_text(json.dumps(record))


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

    def run_report(self, **options):
        return self.x.ui_report(**options)['runs'][0]


class Values(Base):
    def test_identical_downloads_are_exact_and_equal_the_engine_files(self):
        report = self.x.ui_report()
        run = report['runs'][0]
        self.assertEqual(run['class'], 'exact')
        self.assertEqual(report['matlab']['image']['id'], IMAGE)
        self.assertEqual(run['engineFiles']['differ'] + run['engineFiles']['missing'], [])
        self.assertEqual(report['summary']['engineFilesEqual'], len(self.names) + 2)
        self.assertEqual(run['notCompared']['uiOnly'], sorted(set(run['engineFiles']['equal']) - set(self.names)))

    def test_one_float32_ulp_differs_in_both_comparisons(self):
        values = self.x.maps[self.id][1].astype('<f4')
        values[ROI[0]] = numpy.nextafter(values[ROI[0]], numpy.float32(numpy.inf))
        self.x.write_ui({(self.id, self.names[1]): values})
        entry = self.run_report()['maps'][1]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['gifti']['differing'], 1)
        self.assertEqual(entry['srfDataCast']['differing'], 1)

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

    def test_engine_byte_difference_is_reported(self):
        engine = self.x.engine / self.id / self.names[0]
        engine.write_bytes(engine.read_bytes() + b' ')
        run = self.run_report()
        self.assertEqual(run['class'], 'exact')
        self.assertEqual(run['engineFiles']['differ'], [self.names[0]])


class DoublePrecision(Base):
    ids = ['rc_hull_lh_double']

    def test_double_values_beyond_float32_are_not_observable_and_say_so(self):
        self.x.maps[self.id][1][ROI[0]] = numpy.nextafter(self.x.maps[self.id][1][ROI[0]], numpy.inf)
        self.x.write()
        entry = self.run_report()['maps'][1]
        self.assertEqual(entry['srfDataPrecision'], 'double')
        self.assertTrue(entry['srfDataCast']['exact'])


class Statuses(Base):
    ids = ['rc_hull_lh_single', 'rc_gaussian_lh_single', 'prf_custom_hrf_lh_double']

    def classes(self, report=None):
        return {run['id']: run['class'] for run in (report or self.x.ui_report())['runs']}

    def test_expected_refusal_and_unsupported_route_are_listed_not_agreement(self):
        report = self.x.ui_report()
        self.assertEqual(self.classes(report), {'rc_hull_lh_single': 'exact', 'rc_gaussian_lh_single': 'refused',
                                                'prf_custom_hrf_lh_double': 'unsupported'})
        self.assertEqual(report['summary']['exactRuns'], 1)

    def test_ui_error_after_a_result_is_compared_and_counted(self):
        self.x.ui_status['rc_hull_lh_single'] = 'succeeded-ui-error'
        self.x.write_ui()
        report = self.x.ui_report()
        self.assertEqual(self.classes(report)['rc_hull_lh_single'], 'exact')
        self.assertEqual(report['summary']['uiErrorRuns'], 1)

    def test_unexpected_statuses_fail(self):
        for run_id, status in (('rc_hull_lh_single', 'refused'), ('rc_hull_lh_single', 'failed'),
                               ('rc_gaussian_lh_single', 'succeeded'), ('prf_custom_hrf_lh_double', 'succeeded')):
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
    def assertInventory(self, message=None):
        run = self.run_report()
        self.assertEqual(run['class'], 'inventory-error')
        if message:
            self.assertIn(message, run['error'])

    def test_zip_hash_must_match_the_record(self):
        self.x.edit_ui(self.id, zipSha256='0' * 64)
        self.assertInventory()

    def test_missing_contract_map_and_unexpected_file(self):
        for change in ('missing', 'extra'):
            with self.subTest(change=change):
                self.x.write_ui()
                archive = next((self.x.ui / self.id).glob('*.zip'))
                with zipfile.ZipFile(archive) as handle:
                    entries = {name: handle.read(name) for name in handle.namelist()}
                if change == 'missing':
                    del entries[self.names[0]]
                else:
                    entries['extra.gii'] = entries[self.names[0]]
                with zipfile.ZipFile(archive, 'w') as handle:
                    for name, data in entries.items():
                        handle.writestr(name, data)
                self.x.edit_ui(self.id, zipSha256=sha(archive.read_bytes()))
                self.assertInventory('lacks contract maps' if change == 'missing' else 'unexpected downloaded files')

    def test_download_must_cover_every_vertex(self):
        self.x.write_ui({(self.id, self.names[0]): numpy.zeros(VERTICES - 1, '<f4')})
        self.assertInventory()


class Provenance(Base):
    def test_compiled_receipts_and_matching_plan_are_required(self):
        with self.assertRaises(Inventory):
            ui_cli.compare(self.x.plan, self.x.plan_sha, self.x.manifest, self.x.manifest_sha, self.x.ui,
                           self.x.matlab, 'source', scratch=self.x.root / 'extracted')
        for key in ('planSha256', 'bundleSha256', 'runner', 'wasmSha256'):
            with self.subTest(key=key):
                self.x.write_ui()
                path = self.x.ui / 'environment.json'
                environment = json.loads(path.read_text())
                environment[key] = 'node' if key == 'runner' else 'd' * 64 if key != 'wasmSha256' else None
                path.write_text(json.dumps(environment))
                with self.assertRaises(Inventory):
                    self.x.ui_report()

    def test_record_identity_and_status_must_be_valid(self):
        for change in ({'id': 'another_run'}, {'status': 'exact'}):
            with self.subTest(change=change):
                self.x.write_ui()
                self.x.edit_ui(self.id, **change)
                with self.assertRaises(Inventory):
                    self.x.ui_report()

    def test_command_line_exit_codes(self):
        plan = self.x.root / 'plan.json'
        manifest = self.x.root / 'manifest.json'
        plan.write_text(json.dumps(self.x.plan))
        manifest.write_text(json.dumps(self.x.manifest))
        self.x.plan_sha = sha(plan.read_bytes())
        self.x.manifest_sha = sha(manifest.read_bytes())
        self.x.write()
        for edit, code in ((None, 0), ({'zipSha256': '0' * 64}, 1)):
            with self.subTest(edit=edit):
                self.x.write_ui()
                if edit:
                    self.x.edit_ui(self.id, **edit)
                result = subprocess.run([sys.executable, str(HERE / 'compare_ui_cli.py'), str(plan), str(manifest),
                                         str(self.x.ui), str(self.x.matlab), str(self.x.root / f'report-{code}.json'),
                                         '--expect', 'compiled-runtime', '--engine-root', str(self.x.engine)],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, code, result.stderr)


class RunTranslation(unittest.TestCase):
    """run_ui_matrix.mjs's uiRun: the files and settings a person gives the app."""

    def translate(self, run, bundle):
        script = ("import { uiRun } from " + json.dumps((HERE / 'run_ui_matrix.mjs').as_uri()) + ";"
                  "const [run, bundle] = JSON.parse(process.argv[1]);"
                  "try { console.log(JSON.stringify(uiRun(run, bundle))); }"
                  "catch (error) { console.log(JSON.stringify({ error: error.message })); }")
        result = subprocess.run(['node', '--input-type=module', '-e', script, json.dumps([run, str(bundle)])],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def setUp(self):
        self._scratch = scratch()
        self.bundle = Path(self._scratch.name)
        for name in ('lh_ubars2.gii', 'lh_ubars1.gii', 'lh_ubars10.gii', 'lh_benson.gii', 'lh_other.gii'):
            (self.bundle / 'x001_lh').mkdir(exist_ok=True)
            (self.bundle / 'x001_lh' / name).write_text('')

    def tearDown(self):
        self._scratch.cleanup()

    def test_forward_cf_and_subject_hrf_runs(self):
        prf = self.translate(PLAN['prf_gaussian_lh_concatenate_single'], self.bundle)
        self.assertEqual(prf['algorithm'], 'prf')
        self.assertEqual(prf['combine'], 'concatenate')
        self.assertEqual(prf['model']['Data_Precision'], 'single')
        self.assertEqual([Path(p).name for p in prf['files']['runs']], ['lh_ubars1.gii', 'lh_ubars10.gii', 'lh_ubars2.gii'])
        self.assertEqual([Path(p).name for p in prf['files']['surfaces']], ['lh.white', 'lh.area'])
        self.assertTrue(prf['files']['apertures'][0].endswith('.mat'))
        self.assertIsNone(prf['unsupported'])
        cf = self.translate(PLAN['cf_hull_lh_double'], self.bundle)
        self.assertEqual(Path(cf['files']['template'][0]).name, 'lh_benson.gii')
        self.assertEqual(Path(cf['files']['seed'][0]).name, 'seed.label')
        self.assertNotIn('apertures', cf['files'])
        custom = self.translate(PLAN['rc_custom_hrf_lh_double'], self.bundle)
        self.assertIn('subject-HRF', custom['unsupported'])

    def test_unplanned_arguments_are_refused(self):
        run = json.loads(json.dumps(PLAN['rc_hull_lh_single']))
        run['argv'] = [value.replace('-norm=1', '-norm=0') for value in run['argv']]
        self.assertIn('only -norm=1', self.translate(run, self.bundle)['error'])


if __name__ == '__main__':
    unittest.main()
