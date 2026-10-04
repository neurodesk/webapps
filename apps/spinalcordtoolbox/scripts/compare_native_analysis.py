import pathlib
import pickle
import zipfile
import pandas as pd
import numpy as np
import nibabel as nib

root = pathlib.Path('/job')
for case in ['morphometry-default', 'morphometry-weighted', 'lesion-cord', 'lesion-only', 'lesion-uncompressed']:
    directory = root / case
    if case.startswith('morphometry'):
        actual = pd.read_csv(directory / 'api/morphometry.csv')
        expected = pd.read_csv(directory / 'out/morphometry.csv')
        assert actual.columns.tolist() == expected.columns.tolist()
        ignored = [column for column in actual if column.lower() in ('timestamp', 'date', 'time')]
        pd.testing.assert_frame_equal(actual.drop(columns=ignored), expected.drop(columns=ignored), check_exact=True)
        print(f'{case}: {len(actual)} rows, {len(actual.columns) - len(ignored)} columns exactly equal; excluded run metadata {ignored}')
    else:
        with zipfile.ZipFile(directory / 'api/lesion_analysis.xlsx') as actual, zipfile.ZipFile(directory / 'out/lesion_analysis.xlsx') as expected:
            assert actual.namelist() == expected.namelist()
            for name in actual.namelist():
                if name != 'docProps/core.xml':
                    assert actual.read(name) == expected.read(name), f'{case}/{name}'
        with open(directory / 'api/lesion_analysis.pkl', 'rb') as handle:
            actual_pickle = pickle.load(handle)
        with open(directory / 'out/lesion_analysis.pkl', 'rb') as handle:
            expected_pickle = pickle.load(handle)
        assert actual_pickle.keys() == expected_pickle.keys()
        for key in actual_pickle:
            pd.testing.assert_frame_equal(actual_pickle[key], expected_pickle[key], check_exact=True)
        label = 'lesion_label.nii' if case == 'lesion-uncompressed' else 'lesion_label.nii.gz'
        actual_image = nib.load(directory / 'api' / label)
        expected_image = nib.load(directory / 'out' / label)
        np.testing.assert_array_equal(actual_image.get_fdata(), expected_image.get_fdata())
        np.testing.assert_array_equal(actual_image.affine, expected_image.affine)
        print(f'{case}: all XLSX/pickle data values and labeled NIfTI voxels/affine exactly equal.')
