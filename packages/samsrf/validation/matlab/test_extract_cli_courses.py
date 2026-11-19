import json
from pathlib import Path
import unittest

import h5py
import numpy

import extract_cli_courses
from test_cli import scratch


class CourseInventory(unittest.TestCase):
    def setUp(self):
        self.temporary = scratch()
        self.root = Path(self.temporary.name)
        self.output = self.root / 'extracted'
        self.plan = {'runs': [{'id': name, 'precision': 'double'} for name in ('a', 'b')]}
        (self.root / 'plan.json').write_text(json.dumps(self.plan))
        for prefix, cpu in (('', 'AMD EPYC'), ('ubuntu-24.04', 'Intel Xeon')):
            source = self.root / prefix / 'source-1'
            (source / 'receipts').mkdir(parents=True)
            (source / 'receipts' / 'environment.json').write_text(json.dumps({
                'cpu': f'Model name: {cpu}\n', 'blas': 'CNR branch AUTO',
            }))
            for name in ('a', 'b'):
                (source / name).mkdir()
                with h5py.File(source / name / 'result.mat', 'w') as handle:
                    srf = handle.create_group('Srf')
                    srf.create_dataset('Y', data=numpy.array([[1., 2.]], dtype='<f8'))
                    srf.create_dataset('Roi', data=numpy.array([1.], dtype='<f8'))

    def tearDown(self):
        self.temporary.cleanup()

    def test_complete_inventory_is_extracted(self):
        extract_cli_courses.main([str(self.root), str(self.output)])
        result = json.loads((self.output / 'manifest.json').read_text())
        for host in result['hosts'].values():
            self.assertEqual([run['id'] for run in host['runs']], ['a', 'b'])

    def test_missing_planned_run_is_rejected(self):
        self.plan['runs'].append({'id': 'absent', 'precision': 'double'})
        (self.root / 'plan.json').write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(ValueError, 'missing planned run directories'):
            extract_cli_courses.main([str(self.root), str(self.output)])

    def test_duplicate_plan_identity_is_rejected(self):
        self.plan['runs'][1] = self.plan['runs'][0]
        (self.root / 'plan.json').write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(ValueError, 'unique run identities'):
            extract_cli_courses.main([str(self.root), str(self.output)])

    def test_roi_must_be_distinct_whole_vertex_numbers(self):
        for roi in ([1.5], [0.], [float('nan')]):
            with self.subTest(roi=roi):
                with h5py.File(self.root / 'source-1' / 'a' / 'result.mat', 'a') as handle:
                    del handle['Srf']['Roi']
                    handle['Srf'].create_dataset('Roi', data=numpy.array(roi, dtype='<f8'))
                with self.assertRaisesRegex(ValueError, 'distinct whole vertex numbers'):
                    extract_cli_courses.main([str(self.root), str(self.root / f'extracted-{roi[0]}')])


if __name__ == '__main__':
    unittest.main()
