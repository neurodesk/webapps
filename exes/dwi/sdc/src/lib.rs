// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
//! Deterministic field conversion and B-spline approximation from sdcflows 2.17.1.
//! Arrays use NIfTI's x-fastest voxel order. Displacements are interleaved LPS mm.
//! Geometry and fitting follow transform.py and interfaces/bspline.py at 96a4e142.

use std::fmt;

pub const DEFAULT_HF_ZOOMS_MM: [f64; 3] = [16.0, 16.0, 10.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhaseEncoding {
    axis: usize,
    negative: bool,
}
impl TryFrom<&str> for PhaseEncoding {
    type Error = Error;
    fn try_from(value: &str) -> Result<Self, Error> {
        let axis = match value {
            "i" | "i-" => 0,
            "j" | "j-" => 1,
            "k" | "k-" => 2,
            _ => return Err(Error("Phase encoding must be i, i-, j, j-, k or k-")),
        };
        Ok(Self {
            axis,
            negative: value.ends_with('-'),
        })
    }
}
impl PhaseEncoding {
    fn scale(self, readout: f64) -> Result<f64, Error> {
        if !readout.is_finite() || readout <= 0.0 {
            return Err(Error("Readout time must be finite and positive"));
        }
        let single = readout as f32;
        if !single.is_finite() || single <= 0.0 {
            return Err(Error(
                "Readout time must fit in finite positive Float32 seconds",
            ));
        }
        Ok(if self.negative { -readout } else { readout })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    shape: [usize; 3],
    affine: [[f64; 4]; 4],
}
impl Grid {
    pub fn new(shape: [usize; 3], affine: [[f64; 4]; 4]) -> Result<Self, Error> {
        if shape.contains(&0)
            || shape
                .iter()
                .try_fold(1usize, |a, &b| a.checked_mul(b))
                .is_none()
        {
            return Err(Error("Grid shape must be nonempty and fit in memory"));
        }
        if affine.iter().flatten().any(|v| !v.is_finite()) || affine[3] != [0.0, 0.0, 0.0, 1.0] {
            return Err(Error("Grid affine must be a finite homogeneous matrix"));
        }
        inverse(&affine)?;
        Ok(Self { shape, affine })
    }
    pub fn shape(&self) -> [usize; 3] {
        self.shape
    }
    pub fn affine(&self) -> [[f64; 4]; 4] {
        self.affine
    }
    pub fn len(&self) -> usize {
        self.shape.iter().product()
    }
    pub fn is_empty(&self) -> bool {
        false
    }
    fn index(&self, p: [usize; 3]) -> usize {
        p[0] + self.shape[0] * (p[1] + self.shape[1] * p[2])
    }
    fn zooms(&self) -> [f64; 3] {
        std::array::from_fn(|j| {
            (0..3)
                .map(|i| self.affine[i][j].powi(2))
                .sum::<f64>()
                .sqrt()
        })
    }
}

fn inverse(a: &[[f64; 4]; 4]) -> Result<[[f64; 3]; 3], Error> {
    let d = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    if !d.is_finite() || d == 0.0 {
        return Err(Error("Grid affine must be invertible"));
    }
    let result: [[f64; 3]; 3] = std::array::from_fn(|i| {
        std::array::from_fn(|j| {
            let rows: Vec<_> = (0..3).filter(|&r| r != j).collect();
            let cols: Vec<_> = (0..3).filter(|&c| c != i).collect();
            let sign = if (i + j) % 2 == 0 { 1.0 } else { -1.0 };
            sign * (a[rows[0]][cols[0]] * a[rows[1]][cols[1]]
                - a[rows[0]][cols[1]] * a[rows[1]][cols[0]])
                / d
        })
    });
    if result.iter().flatten().any(|value| !value.is_finite()) {
        return Err(Error("Grid affine inverse must be finite"));
    }
    Ok(result)
}
fn check_values(values: &[f32], count: usize) -> Result<(), Error> {
    if values.len() != count {
        return Err(Error("Voxel array length does not match the grid"));
    }
    if values.iter().any(|v| !v.is_finite()) {
        return Err(Error("Voxel arrays must contain finite values"));
    }
    Ok(())
}

/// sdcflows disp_to_fmap: LPS displacement to PE voxel shift, rounded to f32 before division.
/// The EPI grid supplies voxel axes; the displacement may be sampled on another grid.
pub fn displacement_to_field(
    displacement: &[f32],
    grid: &Grid,
    readout: f64,
    pe: PhaseEncoding,
) -> Result<Vec<f32>, Error> {
    if displacement.is_empty() || displacement.len() % 3 != 0 {
        return Err(Error(
            "Displacements must contain complete interleaved vectors",
        ));
    }
    check_values(displacement, displacement.len())?;
    let scale = pe.scale(readout)? as f32;
    let inv = inverse(&grid.affine)?;
    displacement
        .chunks_exact(3)
        .map(|v| {
            let xyz = [-f64::from(v[0]), -f64::from(v[1]), f64::from(v[2])];
            let voxel = (0..3).map(|j| inv[pe.axis][j] * xyz[j]).sum::<f64>() as f32;
            let field = voxel / scale;
            if !field.is_finite() {
                return Err(Error("Converted field exceeds the finite Float32 range"));
            }
            Ok(field)
        })
        .collect()
}

/// sdcflows fmap_to_disp: round PE voxel shifts to f32, then transform them to LPS mm.
pub fn field_to_displacement(
    field: &[f32],
    grid: &Grid,
    readout: f64,
    pe: PhaseEncoding,
) -> Result<Vec<f32>, Error> {
    check_values(field, grid.len())?;
    let scale = pe.scale(readout)?;
    let mut out = Vec::with_capacity(grid.len() * 3);
    for &value in field {
        let voxel = f64::from((f64::from(value) * scale) as f32);
        if !voxel.is_finite() {
            return Err(Error("Voxel shift exceeds the finite Float32 range"));
        }
        for i in 0..3 {
            let displacement =
                (grid.affine[i][pe.axis] * voxel * if i < 2 { -1.0 } else { 1.0 }) as f32;
            if !displacement.is_finite() {
                return Err(Error("Displacement exceeds the finite Float32 range"));
            }
            out.push(displacement);
        }
    }
    Ok(out)
}

/// sdcflows bspline_grid: floor the physical extent, add three knots and centre both grids.
pub fn control_grid(image: &Grid, spacing: [f64; 3]) -> Result<Grid, Error> {
    if spacing.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return Err(Error("Control point spacing must be finite and positive"));
    }
    let zooms = image.zooms();
    let mut affine = [[0.0; 4]; 4];
    affine[3][3] = 1.0;
    for (i, row) in affine.iter_mut().enumerate().take(3) {
        for (j, value) in row.iter_mut().enumerate().take(3) {
            *value = spacing[j] * image.affine[i][j] / zooms[j];
        }
    }
    let actual: [f64; 3] =
        std::array::from_fn(|j| (0..3).map(|i| affine[i][j].powi(2)).sum::<f64>().sqrt());
    let mut shape = [0; 3];
    for j in 0..3 {
        let count = ((zooms[j] * (image.shape[j] - 1) as f64) / actual[j]).floor();
        if !count.is_finite() || count < 0.0 || count > (usize::MAX - 3) as f64 {
            return Err(Error("Control grid dimensions exceed addressable memory"));
        }
        shape[j] = (count as usize)
            .checked_add(3)
            .ok_or(Error("Control grid is too large"))?;
    }
    for (i, row) in affine.iter_mut().enumerate().take(3) {
        row[3] = image.affine[i][3]
            + (0..3)
                .map(|j| {
                    image.affine[i][j] * (image.shape[j] - 1) as f64 * 0.5
                        - row[j] * (shape[j] - 1) as f64 * 0.5
                })
                .sum::<f64>();
    }
    Grid::new(shape, affine)
}

/// Check the conservative CSR and working-buffer footprint against wasm32's address space.
/// Reserve 512 MiB of the 4 GiB heap for allocator overhead, stack and host ABI buffers.
pub fn validate_wasm_fit(image: &Grid) -> Result<(), Error> {
    let control = control_grid(image, DEFAULT_HF_ZOOMS_MM)?;
    validate_wasm_storage(image, &control, true)
}

/// Check the bounded storage required for evaluating an existing coefficient grid.
pub fn validate_wasm_evaluation(image: &Grid, control: &Grid) -> Result<(), Error> {
    validate_wasm_storage(image, control, false)
}

fn validate_wasm_storage(image: &Grid, control: &Grid, fitting: bool) -> Result<(), Error> {
    const BUDGET: u64 = 7 * 512 * 1024 * 1024;
    let rows = image.len() as u64;
    let columns = control.len() as u64;
    let solver = rows.min(columns);
    let checked = || -> Option<u64> {
        // Up to 4^3 nonzeros per sample, each u32 column + f32 value.
        let csr = rows.checked_mul(64)?.checked_mul(8)?;
        // CSR row starts + voxel-order map, and five Float32 sample buffers.
        let samples = rows
            .checked_mul(if fitting { 28 } else { 16 })?
            .checked_add(4)?;
        // CG vectors, coefficient copies, per-axis stencils and fixed metadata.
        let vectors = if fitting {
            solver
                .checked_mul(10)?
                .checked_add(columns.checked_mul(3)?)?
                .checked_mul(4)?
        } else {
            columns.checked_mul(8)?
        };
        let axes = image
            .shape
            .iter()
            .try_fold(0u64, |n, &dim| n.checked_add(dim as u64))?
            .checked_mul(48)?;
        csr.checked_add(samples)?
            .checked_add(vectors)?
            .checked_add(axes)?
            .checked_add(8192)
    };
    if checked().is_none_or(|bytes| bytes > BUDGET) {
        return Err(Error(
            "Field-fit CSR and buffers exceed the 3.5 GiB WebAssembly working budget",
        ));
    }
    Ok(())
}

fn basis(distance: f64) -> f32 {
    let d = distance.abs();
    if d < 1.0 {
        (2.0 / 3.0 - d * d + 0.5 * d * d * d) as f32
    } else if d < 2.0 {
        ((2.0 - d).powi(3) / 6.0) as f32
    } else {
        0.0
    }
}

// CSR rows and columns follow NumPy's C-order traversal, so transpose accumulation
// has the same order as scipy's CSR operator. Public arrays remain x-fastest.
struct Weights {
    columns: usize,
    indices: Vec<u32>,
    values: Vec<f32>,
    starts: Vec<usize>,
    voxels: Vec<usize>,
}
impl Weights {
    fn new(image: &Grid, control: &Grid) -> Result<Self, Error> {
        // The source uses a separable operator and warns when axes are not parallel.
        // Refuse that case instead of returning an incorrectly projected field.
        for axis in 0..3 {
            let a: [f64; 3] = std::array::from_fn(|i| image.affine[i][axis]);
            let b: [f64; 3] = std::array::from_fn(|i| control.affine[i][axis]);
            let cross = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            if cross.iter().map(|v| v * v).sum::<f64>().sqrt() > 1e-3 {
                return Err(Error(
                    "B-spline evaluation requires parallel corresponding grid axes",
                ));
            }
        }
        let inv = inverse(&control.affine)?;
        let axes: [Vec<Vec<(usize, f32)>>; 3] = std::array::from_fn(|j| {
            let step = (0..3).map(|i| inv[j][i] * image.affine[i][j]).sum::<f64>();
            let offset = (0..3)
                .map(|i| inv[j][i] * (image.affine[i][3] - control.affine[i][3]))
                .sum::<f64>();
            (0..image.shape[j])
                .map(|p| {
                    let loc = p as f64 * step + offset;
                    (0..control.shape[j])
                        .filter_map(|k| {
                            let w = basis(loc - k as f64);
                            (w > 0.0).then_some((k, w))
                        })
                        .collect()
                })
                .collect()
        });
        let maximum_nonzeros = image
            .len()
            .checked_mul(64)
            .ok_or(Error("Field-fit CSR size overflow"))?;
        let mut result = Self {
            columns: control.len(),
            indices: Vec::new(),
            values: Vec::new(),
            starts: Vec::new(),
            voxels: Vec::new(),
        };
        result
            .indices
            .try_reserve_exact(maximum_nonzeros)
            .map_err(|_| Error("Not enough memory for field-fit CSR indices"))?;
        result
            .values
            .try_reserve_exact(maximum_nonzeros)
            .map_err(|_| Error("Not enough memory for field-fit CSR weights"))?;
        result
            .starts
            .try_reserve_exact(
                image
                    .len()
                    .checked_add(1)
                    .ok_or(Error("Field-fit row size overflow"))?,
            )
            .map_err(|_| Error("Not enough memory for field-fit CSR rows"))?;
        result
            .voxels
            .try_reserve_exact(image.len())
            .map_err(|_| Error("Not enough memory for field-fit voxel indices"))?;
        result.starts.push(0);
        for x in 0..image.shape[0] {
            for y in 0..image.shape[1] {
                for z in 0..image.shape[2] {
                    result.voxels.push(image.index([x, y, z]));
                    for &(cx, wx) in &axes[0][x] {
                        for &(cy, wy) in &axes[1][y] {
                            for &(cz, wz) in &axes[2][z] {
                                result.indices.push(
                                    u32::try_from(
                                        cz + control.shape[2] * (cy + control.shape[1] * cx),
                                    )
                                    .map_err(|_| Error("Control grid is too large"))?,
                                );
                                result.values.push((wx * wy) * wz);
                            }
                        }
                    }
                    result.starts.push(result.indices.len());
                }
            }
        }
        Ok(result)
    }
    fn apply(&self, coefficients: &[f32]) -> Vec<f32> {
        self.starts
            .windows(2)
            .map(|span| {
                (span[0]..span[1]).fold(0.0, |v, j| {
                    v + self.values[j] * coefficients[self.indices[j] as usize]
                })
            })
            .collect()
    }
    fn transpose(&self, samples: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0; self.columns];
        for (span, &sample) in self.starts.windows(2).zip(samples) {
            for j in span[0]..span[1] {
                out[self.indices[j] as usize] += self.values[j] * sample;
            }
        }
        out
    }
}

#[derive(Clone, Debug)]
pub struct Fit {
    pub grid: Grid,
    pub coefficients: Vec<f32>,
    pub field: Vec<f32>,
    pub iterations: usize,
}

// OpenBLAS SkylakeX sdot, the kernel selected by the reference host's Zen5 CPU.
// Express the AVX512 reduction portably so native and WASM share its rounding.
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let full = a.len() / 32 * 32;
    let full64 = full / 64 * 64;
    let mut wide = [[0.0f32; 16]; 4];
    for block in (0..full64).step_by(64) {
        for (group, values) in wide.iter_mut().enumerate() {
            for (lane, value) in values.iter_mut().enumerate() {
                let i = block + group * 16 + lane;
                *value = a[i].mul_add(b[i], *value);
            }
        }
    }
    let mut lanes: [[f32; 8]; 4] =
        std::array::from_fn(|g| std::array::from_fn(|j| wide[g][j] + wide[g][j + 8]));
    for block in (full64..full).step_by(32) {
        for (group, values) in lanes.iter_mut().enumerate() {
            for (lane, value) in values.iter_mut().enumerate() {
                let i = block + group * 8 + lane;
                *value = a[i].mul_add(b[i], *value);
            }
        }
    }
    let sum: [f32; 8] =
        std::array::from_fn(|j| ((lanes[0][j] + lanes[1][j]) + lanes[2][j]) + lanes[3][j]);
    let half: [f32; 4] = std::array::from_fn(|j| sum[j] + sum[j + 4]);
    let vector = (half[0] + half[1]) + (half[2] + half[3]);
    let tail: f64 = (full..a.len()).map(|i| f64::from(a[i] * b[i])).sum();
    (tail + f64::from(vector)) as f32
}

fn c_order(values: &[f32], grid: &Grid) -> Vec<f32> {
    (0..grid.shape[0])
        .flat_map(|x| {
            (0..grid.shape[1])
                .flat_map(move |y| (0..grid.shape[2]).map(move |z| values[grid.index([x, y, z])]))
        })
        .collect()
}
fn x_order(values: &[f32], grid: &Grid) -> Vec<f32> {
    let mut out = vec![0.0; grid.len()];
    let mut k = 0;
    for x in 0..grid.shape[0] {
        for y in 0..grid.shape[1] {
            for z in 0..grid.shape[2] {
                out[grid.index([x, y, z])] = values[k];
                k += 1;
            }
        }
    }
    out
}

/// Ridge(alpha=1e-4, fit_intercept=false), scipy sparse CG(rtol=1e-4, atol=0).
/// This entry fits one HF grid with no mask, no recentering and full-grid extrapolation.
pub fn approximate(field: &[f32], image: &Grid) -> Result<Fit, Error> {
    check_values(field, image.len())?;
    if image.zooms().iter().any(|&value| value < 1.0) {
        return Err(Error(
            "Resample the fitting grid to at least 1 mm before the HF fit",
        ));
    }
    let grid = control_grid(image, DEFAULT_HF_ZOOMS_MM)?;
    let weights = Weights::new(image, &grid)?;
    let data: Vec<_> = weights.voxels.iter().map(|&i| field[i]).collect();
    let dual = weights.columns > data.len();
    let rhs = if dual {
        data.clone()
    } else {
        weights.transpose(&data)
    };
    let mut r = rhs.clone();
    let mut x = vec![0.0; rhs.len()];
    let mut p = r.clone();
    let mut rho = dot(&r, &r);
    let threshold = dot(&rhs, &rhs).sqrt() * 1e-4;
    let mut iterations = 0;
    for iteration in 0..rhs.len() * 10 {
        if dot(&r, &r).sqrt() < threshold || rho == 0.0 {
            break;
        }
        let mut q = if dual {
            weights.apply(&weights.transpose(&p))
        } else {
            weights.transpose(&weights.apply(&p))
        };
        for (value, &p) in q.iter_mut().zip(&p) {
            *value += 1e-4 * p;
        }
        let alpha = rho / dot(&p, &q);
        for i in 0..x.len() {
            x[i] += alpha * p[i];
            r[i] -= alpha * q[i];
        }
        let next = dot(&r, &r);
        let beta = next / rho;
        for i in 0..p.len() {
            p[i] = r[i] + beta * p[i];
        }
        rho = next;
        iterations = iteration + 1;
    }
    let x = if dual { weights.transpose(&x) } else { x };
    if x.iter().any(|v| !v.is_finite() || v.abs() >= 1e4) {
        return Err(Error(
            "B-spline fit failed: nonfinite or extreme coefficients",
        ));
    }
    let fitted = x_order(&weights.apply(&x), image);
    Ok(Fit {
        coefficients: x_order(&x, &grid),
        grid,
        field: fitted,
        iterations,
    })
}

pub fn evaluate(coefficients: &[f32], control: &Grid, image: &Grid) -> Result<Vec<f32>, Error> {
    check_values(coefficients, control.len())?;
    let weights = Weights::new(image, control)?;
    Ok(x_order(
        &weights.apply(&c_order(coefficients, control)),
        image,
    ))
}
