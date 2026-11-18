import json
from pathlib import Path
import struct
import unittest

import h5py
import numpy

import extract_cli_rc_hulls
from test_cli import scratch

VALUES = ['R^2', 'x0', 'y0', 'Fwhm', 'Beta', 'Noise Ceiling']


def write_maps(path, data, raw, roi, values=VALUES):
    """A MAT v7.3 Srf as MATLAB writes it: arrays transposed, Values as a cell of char arrays."""
    with h5py.File(path, 'w') as handle:
        refs = handle.create_group('#refs#')
        labels = [refs.create_dataset(f'v{i}', data=numpy.array([[ord(c)] for c in name], dtype='<u2')).ref for i, name in enumerate(values)]
        srf = handle.create_group('Srf')
        srf.create_dataset('Values', data=numpy.array([labels], dtype=h5py.ref_dtype))
        srf.create_dataset('Data', data=numpy.asarray(data, dtype='<f8').T)
        srf.create_dataset('Raw_Data', data=numpy.asarray(raw, dtype='<f8').T)
        srf.create_dataset('Roi', data=numpy.array([roi], dtype='<f8'))


def write_grid(path, xc, yc):
    with h5py.File(path, 'w') as handle:
        handle.create_dataset('xc', data=numpy.asarray(xc, dtype='<f8').T)
        handle.create_dataset('yc', data=numpy.asarray(yc, dtype='<f8').T)


class RcHullExtraction(unittest.TestCase):
    def setUp(self):
        self.temporary = scratch()
        self.root = Path(self.temporary.name) / 'recording'
        self.output = Path(self.temporary.name) / 'extracted'
        # A 2 x 3 grid: xc varies along columns, yc down the rows.
        self.xc = numpy.array([[-1., 0., 1.], [-1., 0., 1.]])
        self.yc = numpy.array([[1., 1., 1.], [-1., -1., -1.]])
        self.data = numpy.arange(6 * 2, dtype=float).reshape(6, 2)
        self.raw = numpy.arange(5 * 2, dtype=float).reshape(5, 2) + 100
        for prefix in ('', 'ubuntu-24.04'):
            for run in extract_cli_rc_hulls.RUNS:
                directory = self.root / prefix / 'source-1' / run
                directory.mkdir(parents=True)
                write_grid(directory / 'reg_aps_bars.mat', self.xc, self.yc)
                write_maps(directory / f'lh_{run}.mat', self.data, self.raw, [3, 7])

    def tearDown(self):
        self.temporary.cleanup()

    def floats(self, path):
        data = path.read_bytes()
        return list(struct.unpack(f'<{len(data) // 8}d', data))

    def test_grids_and_maps_are_written_in_matlab_order(self):
        extract_cli_rc_hulls.main([str(self.root), str(self.output)])
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(list(manifest), ['amd', 'intel'])
        for host, runs in manifest.items():
            self.assertEqual([run['id'] for run in runs], list(extract_cli_rc_hulls.RUNS))
            for run in runs:
                self.assertEqual((run['rows'], run['columns'], run['values'], run['roi']), (2, 3, VALUES, [3, 7]))
                folder = self.output / host
                self.assertEqual(self.floats(folder / f"{run['id']}.xc.f64"), [-1., -1., 0., 0., 1., 1.])
                self.assertEqual(self.floats(folder / f"{run['id']}.yc.f64"), [1., -1., 1., -1., 1., -1.])
                self.assertEqual(self.floats(folder / f"{run['id']}.data.f64"), list(self.data.T.ravel()))
                self.assertEqual(self.floats(folder / f"{run['id']}.raw.f64"), list(self.raw.T.ravel()))

    def test_missing_map_file_is_rejected(self):
        (self.root / 'ubuntu-24.04' / 'source-1' / extract_cli_rc_hulls.RUNS[1] / f'lh_{extract_cli_rc_hulls.RUNS[1]}.mat').unlink()
        with self.assertRaisesRegex(ValueError, 'expected one map file'):
            extract_cli_rc_hulls.main([str(self.root), str(self.output)])

    def test_raw_rows_other_than_five_are_rejected(self):
        run = extract_cli_rc_hulls.RUNS[0]
        write_maps(self.root / 'source-1' / run / f'lh_{run}.mat', self.data, self.raw[:4], [3, 7])
        with self.assertRaisesRegex(ValueError, 'unexpected shapes'):
            extract_cli_rc_hulls.main([str(self.root), str(self.output)])

    def test_maps_and_roi_of_other_lengths_are_rejected(self):
        run = extract_cli_rc_hulls.RUNS[1]
        write_maps(self.root / 'source-1' / run / f'lh_{run}.mat', self.data, self.raw, [3, 7, 9])
        with self.assertRaisesRegex(ValueError, 'unexpected shapes'):
            extract_cli_rc_hulls.main([str(self.root), str(self.output)])

    def test_complex_maps_are_rejected(self):
        run = extract_cli_rc_hulls.RUNS[0]
        path = self.root / 'source-1' / run / f'lh_{run}.mat'
        with h5py.File(path, 'a') as handle:
            del handle['Srf']['Data']
            complex_type = numpy.dtype([('real', '<f8'), ('imag', '<f8')])
            handle['Srf'].create_dataset('Data', data=numpy.zeros((2, 6), dtype=complex_type))
        with self.assertRaisesRegex(ValueError, 'complex data'):
            extract_cli_rc_hulls.main([str(self.root), str(self.output)])

    def test_an_existing_output_directory_is_refused(self):
        self.output.mkdir()
        with self.assertRaises(FileExistsError):
            extract_cli_rc_hulls.main([str(self.root), str(self.output)])


if __name__ == '__main__':
    unittest.main()
