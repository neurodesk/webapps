import csv
import json
import math
import pathlib
import pickle
import sys
import zipfile

import nibabel as nib
import numpy as np

root = pathlib.Path('/job')
report = {}
tolerance = 0.0 if '--exact' in sys.argv else 1e-12
for directory in sorted(root.iterdir()):
    if not directory.is_dir():
        continue
    actual = directory / 'browser'
    expected = directory / 'native'
    values = []
    if directory.name.startswith('morphometry'):
        with open(actual / 'morphometry.csv') as handle:
            rows_actual = list(csv.DictReader(handle))
        with open(expected / 'morphometry.csv') as handle:
            rows_expected = list(csv.DictReader(handle))
        assert len(rows_actual) == len(rows_expected)
        for index, (row_actual, row_expected) in enumerate(zip(rows_actual, rows_expected)):
            assert row_actual.keys() == row_expected.keys()
            for column in row_actual:
                if column in ['Timestamp', 'Filename']:
                    continue
                try:
                    a, b = float(row_actual[column]), float(row_expected[column])
                except ValueError:
                    assert row_actual[column] == row_expected[column]
                    continue
                values.append((f'{index}/{column}', a, b))
    else:
        with open(actual / 'lesion_analysis.pkl', 'rb') as handle:
            tables_actual = pickle.load(handle)
        with open(expected / 'lesion_analysis.pkl', 'rb') as handle:
            tables_expected = pickle.load(handle)
        assert tables_actual.keys() == tables_expected.keys()
        for key in tables_actual:
            a, b = tables_actual[key], tables_expected[key]
            assert a.columns.tolist() == b.columns.tolist()
            assert a.index.tolist() == b.index.tolist()
            assert a.shape == b.shape
            for column in a:
                for index, (value_a, value_b) in enumerate(zip(a[column], b[column])):
                    try:
                        number_a, number_b = float(value_a), float(value_b)
                    except (ValueError, TypeError):
                        assert value_a == value_b
                        continue
                    values.append((f'{key}/{index}/{column}', number_a, number_b))
        label = 'lesion_label.nii' if directory.name.endswith('uncompressed') else 'lesion_label.nii.gz'
        image_actual, image_expected = nib.load(actual / label), nib.load(expected / label)
        np.testing.assert_array_equal(image_actual.get_fdata(), image_expected.get_fdata())
        np.testing.assert_array_equal(image_actual.affine, image_expected.affine)
        with zipfile.ZipFile(actual / 'lesion_analysis.xlsx') as a, zipfile.ZipFile(expected / 'lesion_analysis.xlsx') as b:
            assert a.namelist() == b.namelist()
            for name in a.namelist():
                if name != 'docProps/core.xml':
                    assert a.read(name) == b.read(name), f'{directory.name}/{name}'
    differences = [{'field': name, 'browser': a, 'native': b, 'absoluteDifference': abs(a - b)}
                   for name, a, b in values if a != b and not (math.isnan(a) and math.isnan(b))]
    report[directory.name] = {
        'numericValues': len(values),
        'differentValues': len(differences),
        'maxAbsoluteDifference': max((item['absoluteDifference'] for item in differences), default=0),
        'differences': differences,
        'outsideTolerance': [item for item in differences if not math.isclose(
            item['browser'], item['native'], rel_tol=tolerance, abs_tol=tolerance)],
        'absoluteTolerance': tolerance,
        'relativeTolerance': tolerance,
    }
    print(directory.name, json.dumps({key: value for key, value in report[directory.name].items() if key not in ['differences', 'outsideTolerance']}))
(root / 'comparison.json').write_text(json.dumps(report, indent=2))
if '--report-only' not in sys.argv:
    assert report, 'No SCT comparison cases were found'
    assert all(not item['outsideTolerance'] for item in report.values()), 'Browser measurements exceed the allowed tolerance; inspect comparison.json'
