"""lossless.py: the Python reader and writer against the package's writeLossless, and the
comparison of one lossless file (from the app or the samsrf command line) with the engine
harness and MATLAB, with negative controls."""

import json
from pathlib import Path
import struct
import subprocess
import unittest

import numpy

import cli_plan
import compare_cli
import lossless
from compare_web_cli import Inventory
from test_cli import scratch
from test_web_cli import PLAN, ROI, Fixture, sha

HERE = Path(__file__).resolve().parent
PACKAGE_WRITER = (HERE.parents[1] / 'src' / 'lossless.js').as_uri()
# Bit patterns a decimal or Number round trip can lose.
AWKWARD = [0xfff8000000000000, 0x7ff8000000000000, 0x7ff8000000000001, 0xfff0000000000001,
           0x8000000000000000, 0x0000000000000000, 0x7ff0000000000000, 0xfff0000000000000,
           0x0000000000000001, 0x7fefffffffffffff]


def from_bits(bits):
    return numpy.array(bits, dtype='<u8').view('<f8')


def package_bytes(case):
    """writeLossless's bytes for a case given as bit patterns."""
    script = ("import { writeLossless } from " + json.dumps(PACKAGE_WRITER) + ";"
              "const c = JSON.parse(process.argv[1]);"
              "const f64 = (bits) => new Float64Array(BigUint64Array.from(bits.map(BigInt)).buffer);"
              "const bytes = writeLossless({ maps: { values: c.values, vertices: c.vertices, data: f64(c.real) },"
              " raw: c.raw ? { values: c.rawValues, vertices: c.vertices, data: f64(c.raw) } : null,"
              " analysed: c.analysed ? Uint32Array.from(c.analysed) : null,"
              " imaginary: c.imaginary ? f64(c.imaginary) : null, arithmeticReference: c.reference }, { precision: c.precision });"
              "process.stdout.write(Buffer.from(bytes).toString('hex'));")
    result = subprocess.run(['node', '--input-type=module', '-e', script, json.dumps(case)],
                            capture_output=True, text=True, check=True)
    return bytes.fromhex(result.stdout)


class Format(unittest.TestCase):
    CASE = {'values': ['R^2', 'x0'], 'vertices': 5, 'real': [str(bits) for bits in AWKWARD],
            'imaginary': [str(bits) for bits in reversed(AWKWARD)], 'rawValues': ['Beta'],
            'raw': [str(bits) for bits in AWKWARD[:5]], 'analysed': [0, 3, 4], 'reference': 'matlab-amd',
            'precision': 'double'}

    def test_the_package_writer_and_this_writer_give_the_same_bytes_and_every_bit_reads_back(self):
        case = self.CASE
        data = package_bytes(case)
        real = from_bits(AWKWARD).reshape(2, 5)
        imaginary = from_bits(list(reversed(AWKWARD))).reshape(2, 5)
        raw = from_bits(AWKWARD[:5]).reshape(1, 5)
        self.assertEqual(lossless.write_lossless(real, case['values'], 'double', 'matlab-amd', imaginary=imaginary,
                                                 raw_values=['Beta'], raw=raw, analysed=[0, 3, 4]), data)
        read = lossless.read_lossless(data)
        self.assertEqual((read['precision'], read['arithmeticReference'], read['vertices'], read['values'], read['rawValues']),
                         ('double', 'matlab-amd', 5, ['R^2', 'x0'], ['Beta']))
        self.assertEqual(read['real'].view('<u8').ravel().tolist(), AWKWARD)
        self.assertEqual(read['imaginary'].view('<u8').ravel().tolist(), list(reversed(AWKWARD)))
        self.assertEqual(read['raw'].view('<u8').ravel().tolist(), AWKWARD[:5])
        self.assertEqual(read['analysed'].tolist(), [0, 3, 4])

    def test_a_real_single_precision_result_without_raw_rows_or_roi(self):
        case = {**self.CASE, 'values': ['x0'], 'vertices': 3, 'real': [str(bits) for bits in
                numpy.array([1 / 3, -0.0, numpy.nan], '<f4').astype('<f8').view('<u8').tolist()],
                'imaginary': None, 'raw': None, 'rawValues': [], 'analysed': None, 'precision': 'single'}
        data = package_bytes(case)
        read = lossless.read_lossless(data)
        self.assertIsNone(read['imaginary'])
        self.assertIsNone(read['analysed'])
        self.assertEqual(read['raw'].shape, (0, 3))
        self.assertEqual(read['precision'], 'single')
        self.assertEqual(read['real'].astype('<f4').astype('<f8').tobytes(), read['real'].tobytes())
        self.assertEqual(lossless.write_lossless(read['real'], ['x0'], 'single', 'matlab-amd'), data)

    def test_any_other_layout_is_refused(self):
        data = package_bytes(self.CASE)
        length = struct.unpack_from('<I', data, 12)[0]
        cases = ((data[:-1], 'length does not match'), (data + b'\0', 'length does not match'),
                 (b'X' + data[1:], 'not a SamSrf lossless file'),
                 (data[:8] + struct.pack('<I', 2) + data[12:], 'unsupported lossless version 2'),
                 (data[:12] + struct.pack('<I', length + 1) + data[16:], 'header length is invalid'),
                 (data.replace(b'"precision":"double"', b'"precision":"triple"'), 'does not describe'))
        for damaged, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(Inventory, message):
                    lossless.read_lossless(damaged)


class CommandLine(unittest.TestCase):
    """lossless.py on a whole-matrix fixture: exit 0 when the file is the engine's, 1 when it is not, 2 refused."""

    run_id = 'prf_css_lh_double'

    def setUp(self):
        self._scratch = scratch()
        self.x = Fixture(self._scratch.name, list(PLAN), kind='compiled', runner='node')
        imaginary = numpy.zeros_like(self.x.maps[self.run_id])
        imaginary[0, ROI] = [-2e-3, 0.0, 5e-4]
        self.x.imaginary[self.run_id] = imaginary
        self.x.plan = cli_plan.plan()
        self.plan = self.x.root / 'plan.json'
        self.manifest = self.x.root / 'manifest.json'
        self.plan.write_text(json.dumps(self.x.plan))
        self.manifest.write_text(json.dumps(self.x.manifest))
        self.x.plan_sha = sha(self.plan.read_bytes())
        self.x.manifest_sha = sha(self.manifest.read_bytes())
        self.x.write()
        self.reports = 0

    def tearDown(self):
        self._scratch.cleanup()

    def write(self, real=None, imaginary=None, run_id=None):
        run = PLAN[run_id or self.run_id]
        labels = compare_cli.expected_results(run)[1]
        path = self.x.root / 'download.bin'
        path.write_bytes(lossless.write_lossless(
            self.x.maps[run['id']] if real is None else real, labels, run['precision'], 'current',
            imaginary=self.x.imaginary.get(run['id']) if imaginary is None else imaginary, analysed=ROI))
        return path

    def cli(self, path, run_id=None):
        self.reports += 1
        report = self.x.root / f'report-{self.reports}.json'
        code = lossless.main([str(self.plan), str(self.manifest), run_id or self.run_id, str(path), str(self.x.matlab),
                              str(report), '--expect', 'compiled-runtime', '--engine-root', str(self.x.web)])
        return code, json.loads(report.read_text()) if report.exists() else None

    def test_the_engine_result_agrees_and_its_complex_maps_are_exact(self):
        code, report = self.cli(self.write())
        self.assertEqual(code, 0)
        self.assertTrue(report['engineAgreement']['equal'])
        self.assertEqual(report['summary']['exactMaps'], report['summary']['maps'])
        self.assertTrue(any(entry['imaginaryNonzero'] for entry in report['maps']))

    def test_matlab_differences_are_reported_not_gated(self):
        # MATLAB records one double one ULP above the engine's, which the file holds.
        values = self.x.maps[self.run_id]
        values[1][ROI[0]] = numpy.nextafter(values[1][ROI[0]], numpy.inf)
        self.x.write()
        values[1][ROI[0]] = numpy.nextafter(values[1][ROI[0]], -numpy.inf)
        engine = self.x.web / self.run_id / 'maps.f64'
        engine.write_bytes(values.astype('<f8').tobytes())
        self.x.edit_record(self.run_id, mapsSha256=sha(engine.read_bytes()))
        code, report = self.cli(self.write())
        self.assertEqual(code, 0)
        self.assertEqual(report['summary']['exactMaps'], report['summary']['maps'] - 1)
        self.assertEqual((report['maps'][1]['srfData']['differing'], report['maps'][1]['srfData']['maxUlp']), (1, 1))

    def test_a_file_that_is_not_the_engine_result_fails(self):
        for real, imaginary in ((-self.x.maps[self.run_id], None), (None, numpy.zeros_like(self.x.maps[self.run_id]))):
            with self.subTest(real=real is not None):
                code, report = self.cli(self.write(real, imaginary))
                self.assertEqual(code, 1)
                self.assertFalse(report['engineAgreement']['equal'])

    def test_refusals(self):
        self.assertEqual(self.cli(self.write(), run_id='no_such_run'), (2, None))
        self.assertEqual(self.cli(self.write(run_id='rc_hull_lh_double')), (2, None))
        refused = next(run_id for run_id, run in PLAN.items() if self.x.status[run_id] == 'refused')
        self.assertEqual(self.cli(self.write(run_id=self.run_id), run_id=refused), (2, None))


if __name__ == '__main__':
    unittest.main()
