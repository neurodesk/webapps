import json
from pathlib import Path
import unittest

import h5py
import numpy

import cli_plan
import compare_cli
import compare_web_cli
from test_cli import scratch, write_gifti

RUN = next(run for run in cli_plan.plan()['runs'] if run['id'] == 'rc_hull_lh_double')
LABELS = compare_cli.expected_results(RUN)[1]
VERTICES = 6
ROI = numpy.array([1, 3, 4])


def write_srf(path, data, roi, kind='double', imaginary=None):
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
        stored = srf.create_dataset('Data', data=values)
        stored.attrs['MATLAB_class'] = numpy.bytes_(kind)
        indices = srf.create_dataset('Roi', data=(numpy.asarray(roi, dtype) + 1)[None, :])
        indices.attrs['MATLAB_class'] = numpy.bytes_(kind)


class WebMatrix(unittest.TestCase):
    def setUp(self):
        self._scratch = scratch()
        root = Path(self._scratch.name)
        self.web = root / 'web'
        self.cli = root / 'cli'
        rng = numpy.random.default_rng(7)
        self.maps = numpy.zeros((len(LABELS), VERTICES))
        self.maps[:, ROI] = rng.standard_normal((len(LABELS), len(ROI)))
        self.write()

    def tearDown(self):
        self._scratch.cleanup()

    def write(self, matlab=None, web=None, status='succeeded', receipt='succeeded', imaginary=None, drop=None):
        matlab = self.maps if matlab is None else matlab
        web = self.maps if web is None else web
        mat, _, names = compare_cli.expected_results(RUN)
        for directory in (self.web / RUN['id'], self.cli / RUN['id'], self.cli / 'receipts'):
            directory.mkdir(parents=True, exist_ok=True)
        (self.web / 'environment.json').write_text('{}')
        record = {'id': RUN['id'], 'status': status, 'values': LABELS, 'vertices': VERTICES}
        if status == 'refused':
            record['message'] = 'Data_Precision=single with a Prf_Function fit is not supported by this port'
        (self.web / f'{RUN["id"]}.web.json').write_text(json.dumps(record))
        (self.cli / 'receipts' / f'{RUN["id"]}.json').write_text(json.dumps({'status': receipt}))
        numpy.asarray(web, '<f8').tofile(self.web / RUN['id'] / 'maps.f64')
        write_srf(self.cli / RUN['id'] / mat, matlab[:, ROI].T, ROI, imaginary=imaginary)
        for index, name in enumerate(names):
            if name == drop:
                (self.cli / RUN['id'] / name).unlink()
            else:
                write_gifti(self.cli / RUN['id'] / name, matlab[index].astype('<f4'))
            write_gifti(self.web / RUN['id'] / name, web[index].astype('<f4'))

    def report(self):
        return compare_web_cli.compare({'runs': [RUN]}, self.web, self.cli, 'test')

    def test_identical_maps_are_exact(self):
        report = self.report()
        self.assertEqual(report['runs'][0]['class'], 'exact')
        self.assertEqual(report['summary']['exactMaps'], len(LABELS))
        self.assertEqual(report['matlabExecution'], 'test')

    def test_one_ulp_in_a_double_map_differs_although_the_gifti_agrees(self):
        web = self.maps.copy()
        web[2, ROI[1]] = numpy.nextafter(web[2, ROI[1]], numpy.inf)
        self.write(web=web)
        entry = self.report()['runs'][0]['maps'][2]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['srfData']['differing'], 1)
        self.assertEqual(entry['srfData']['maxUlp'], 1)
        self.assertTrue(entry['gifti']['exact'])

    def test_signed_zero_is_a_difference(self):
        matlab = self.maps.copy()
        web = self.maps.copy()
        matlab[1, ROI[0]] = 0.0
        web[1, ROI[0]] = -0.0
        self.write(matlab=matlab, web=web)
        entry = self.report()['runs'][0]['maps'][1]
        self.assertEqual(entry['class'], 'differs')
        self.assertEqual(entry['srfData']['signedZeroOnly'], 1)
        self.assertEqual(entry['srfData']['maxAbsolute'], 0)

    def test_nonfinite_mask_mismatch_is_reported(self):
        web = self.maps.copy()
        web[0, ROI[2]] = numpy.nan
        self.write(web=web)
        entry = self.report()['runs'][0]['maps'][0]
        self.assertEqual(entry['class'], 'differs')
        self.assertFalse(entry['srfData']['nonfiniteMaskEqual'])

    def test_matlab_imaginary_part_makes_the_map_differ(self):
        imaginary = numpy.zeros((len(ROI), len(LABELS)))
        imaginary[0, 3] = 1e-3
        self.write(imaginary=imaginary)
        run = self.report()['runs'][0]
        self.assertTrue(run['matlabComplex'])
        self.assertEqual(run['maps'][3]['class'], 'differs')
        self.assertEqual(run['maps'][3]['imaginaryNonzero'], 1)
        self.assertEqual(run['maps'][0]['class'], 'exact')

    def test_refusal_and_failure_are_not_agreement(self):
        self.write(status='refused')
        report = self.report()
        self.assertEqual(report['runs'][0]['class'], 'refused')
        self.assertEqual(report['summary']['exactRuns'], 0)
        self.write(status='unsupported')
        self.assertEqual(self.report()['summary']['unsupportedRuns'], 1)
        self.write(receipt='failed')
        self.assertEqual(self.report()['runs'][0]['class'], 'failed')

    def test_a_missing_matlab_map_is_an_inventory_error(self):
        self.write(drop=compare_cli.expected_results(RUN)[2][4])
        report = self.report()
        self.assertEqual(report['runs'][0]['class'], 'inventory-error')
        self.assertEqual(report['summary']['inventory-errorRuns'], 1)

    def test_a_single_run_must_have_float32_web_values(self):
        run = next(item for item in cli_plan.plan()['runs'] if item['id'] == 'rc_hull_lh_single')
        mat, labels, names = compare_cli.expected_results(run)
        for directory in (self.web / run['id'], self.cli / run['id']):
            directory.mkdir(parents=True, exist_ok=True)
        (self.web / f'{run["id"]}.web.json').write_text(json.dumps({'status': 'succeeded', 'values': labels, 'vertices': VERTICES}))
        (self.cli / 'receipts' / f'{run["id"]}.json').write_text(json.dumps({'status': 'succeeded'}))
        single = self.maps.astype('<f4').astype('<f8')
        web = single.copy()
        web[0, ROI[0]] += 1e-12
        web.tofile(self.web / run['id'] / 'maps.f64')
        write_srf(self.cli / run['id'] / mat, single[:, ROI].T, ROI, kind='single')
        for index, name in enumerate(names):
            write_gifti(self.cli / run['id'] / name, single[index])
            write_gifti(self.web / run['id'] / name, single[index])
        entry = compare_web_cli.compare_run(run, self.web, self.cli)['maps'][0]
        self.assertFalse(entry['castExact'])
        self.assertEqual(entry['class'], 'differs')


if __name__ == '__main__':
    unittest.main()
