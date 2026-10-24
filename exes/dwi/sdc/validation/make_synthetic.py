#!/usr/bin/env python3
"""Independent sdcflows 2.17.1 / sklearn 1.9.1 synthetic oracle, source arrays only."""
import json
import pathlib
import tempfile
import nibabel as nb
import numpy as np
import scipy
import sklearn
import sdcflows
from sdcflows.interfaces.bspline import BSplineApprox, bspline_grid
from sdcflows.transform import grid_bspline_weights

assert (sdcflows.__version__, sklearn.__version__, np.__version__, scipy.__version__) == ('2.17.1', '1.9.1', '2.5.4', '1.18.1')
# 27 control points exercise the same scalar dot tail on every source BLAS CPU.
# The full-brain pinned reference separately checks the AVX512 reduction path.
shape = (6, 7, 3)
affine = np.diag([-2., 2.5, 3., 1.])
affine[:3, 3] = [14., -9., 8.]
xyz = np.indices(shape)
image = nb.Nifti1Image(np.zeros(shape, dtype='float32'), affine)
control = bspline_grid(image, (16., 16., 10.))
known = (np.arange(np.prod(control.shape), dtype='float32') % 13 - 6.) * 2.
fields = {
    'constant': np.full(shape, 5., dtype='float32'),
    'linear': (2. * xyz[0] + .2 * xyz[1] - .5 * xyz[2]).astype('float32'),
    'bspline': np.asarray(grid_bspline_weights(image, control) @ known).reshape(shape),
}
output = {'source': {'sdcflows': sdcflows.__version__, 'sklearn': sklearn.__version__, 'numpy': np.__version__, 'scipy': scipy.__version__}, 'cases': []}
with tempfile.TemporaryDirectory() as temporary:
    for name, data in fields.items():
        directory = pathlib.Path(temporary) / name
        directory.mkdir()
        path = directory / 'input.nii.gz'
        nb.Nifti1Image(data, affine).to_filename(path)
        result = BSplineApprox(in_data=str(path), recenter=False, extrapolate=True).run(cwd=str(directory)).outputs
        fitted = nb.load(result.out_field)
        matrix = grid_bspline_weights(nb.load(path), control).toarray().astype('float64')
        exact = np.linalg.solve(matrix.T @ matrix + np.eye(matrix.shape[1]) * 1e-4, matrix.T @ data.reshape(-1))
        coefficients = nb.load(result.out_coeff if isinstance(result.out_coeff, str) else result.out_coeff[0])
        output['cases'].append({'name': name, 'shape': shape, 'affine': affine.tolist(), 'input': data.ravel(order='F').tolist(), 'controlShape': coefficients.shape, 'controlAffine': coefficients.affine.tolist(), 'coefficients': coefficients.get_fdata(dtype='float32').ravel(order='F').tolist(), 'exactCoefficients': exact.reshape(control.shape).ravel(order='F').tolist(), 'field': fitted.get_fdata(dtype='float32').ravel(order='F').tolist()})
path = pathlib.Path(__file__).parent.parent / 'tests/fixtures/synthetic.json'
path.write_text(json.dumps(output, separators=(',', ':')) + '\n')
print(path)
