//! wasm-bindgen surface of samsrf-core. packages/samsrf/src wraps these exports;
//! see packages/samsrf/README.md for the JavaScript API.
//!
//! Bulk data crosses as typed arrays; structured results are plain JS objects built
//! here (`object`), except the model, which is serde JSON parsed in JS.

use js_sys::{Array, Float32Array, Float64Array, Object, Reflect, Uint32Array, Uint8Array};
use samsrf_core::apertures::{Apertures as CoreApertures, Frame};
use samsrf_core::expr::{AnonymousFunction, Value};
use samsrf_core::model::{AnalysisKind, HrfSpec};
use samsrf_core::preprocess::{self, Combine, Normalise, PreprocessOptions, Preprocessed};
use samsrf_core::surface::{Faces, Surface};
use samsrf_core::timeseries::{RawRun, TimeSeries, VertexSelection};
use samsrf_core::{export, freesurfer, gif_aps, gifti, hrf, job, mapset, mat, model, nifti_aps, prf, template, Error};
use wasm_bindgen::prelude::*;

type Result<T> = std::result::Result<T, JsError>;

fn fail(error: Error) -> JsError {
    JsError::new(&error.to_string())
}

fn shape(message: String) -> JsError {
    fail(Error::Shape(message))
}

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    let target = Object::new();
    for (key, value) in entries {
        Reflect::set(&target, &JsValue::from_str(key), &value).expect("setting a property on a plain object");
    }
    target.into()
}

fn f64s(values: &[f64]) -> JsValue {
    Float64Array::from(values).into()
}

fn flat3(points: &[[f64; 3]]) -> JsValue {
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    f64s(&flat)
}

/// `n x 2` interleaved (x, y per point) to SamSrf's `[x; y]` column-major `Value`.
fn xy_value(xy: &[f64]) -> Result<Value> {
    if !xy.len().is_multiple_of(2) {
        return Err(shape(format!("xy has {} values; it must hold an x and a y per point", xy.len())));
    }
    let rows = xy.len() / 2;
    let mut data = Vec::with_capacity(xy.len());
    data.extend(xy.iter().step_by(2));
    data.extend(xy.iter().skip(1).step_by(2));
    Ok(Value { rows, cols: 2, data })
}

fn points(xy: &[f64]) -> Result<Vec<[f64; 2]>> {
    if !xy.len().is_multiple_of(2) {
        return Err(shape(format!("xy has {} values; it must hold an x and a y per point", xy.len())));
    }
    Ok(xy.as_chunks::<2>().0.to_vec())
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// Readers

#[wasm_bindgen(js_name = readGifti)]
pub fn read_gifti(bytes: &[u8]) -> Result<JsValue> {
    let file = gifti::read(bytes).map_err(fail)?;
    let arrays = Array::new();
    for array in &file.arrays {
        let data_type = match array.data_type {
            gifti::DataType::Float32 => "float32",
            gifti::DataType::Int32 => "int32",
            gifti::DataType::Uint8 => "uint8",
        };
        let dims: Array = array.dims.iter().map(|dim| JsValue::from(*dim as f64)).collect();
        arrays.push(&object(vec![
            ("intent", JsValue::from_str(&array.intent)),
            ("dataType", JsValue::from_str(data_type)),
            ("dims", dims.into()),
            ("data", f64s(&array.data)),
        ]));
    }
    Ok(object(vec![("arrays", arrays.into())]))
}

/// A functional run in wasm memory: float32, vertex-major.
#[wasm_bindgen]
pub struct Run {
    inner: RawRun,
}

#[wasm_bindgen]
impl Run {
    #[wasm_bindgen(getter)]
    pub fn volumes(&self) -> usize {
        self.inner.volumes
    }

    #[wasm_bindgen(getter)]
    pub fn vertices(&self) -> usize {
        self.inner.vertices
    }

    pub fn course(&self, vertex: usize) -> Result<Float32Array> {
        if vertex >= self.inner.vertices {
            return Err(shape(format!("vertex {vertex} is outside the {} vertices of the run", self.inner.vertices)));
        }
        Ok(Float32Array::from(self.inner.course(vertex)))
    }
}

#[wasm_bindgen(js_name = readGiftiRun)]
pub fn read_gifti_run(bytes: &[u8]) -> Result<Run> {
    gifti::read_run(bytes).map(|inner| Run { inner }).map_err(fail)
}

fn surface_object(surface: &Surface) -> JsValue {
    let (faces, face_size): (Vec<u32>, u32) = match &surface.faces {
        Faces::Triangles(faces) => (faces.iter().flatten().copied().collect(), 3),
        Faces::Quads(faces) => (faces.iter().flatten().copied().collect(), 4),
    };
    object(vec![
        ("vertices", flat3(&surface.vertices)),
        ("faces", Uint32Array::from(faces.as_slice()).into()),
        ("faceSize", JsValue::from(face_size)),
    ])
}

#[wasm_bindgen(js_name = readGiftiSurface)]
pub fn read_gifti_surface(bytes: &[u8]) -> Result<JsValue> {
    gifti::read_surface(bytes).map(|surface| surface_object(&surface)).map_err(fail)
}

#[wasm_bindgen(js_name = readFreeSurferSurface)]
pub fn read_freesurfer_surface(bytes: &[u8]) -> Result<JsValue> {
    freesurfer::read_surface(bytes).map(|surface| surface_object(&surface)).map_err(fail)
}

#[wasm_bindgen(js_name = readFreeSurferCurv)]
pub fn read_freesurfer_curv(bytes: &[u8]) -> Result<Vec<f64>> {
    freesurfer::read_curv(bytes).map_err(fail)
}

#[wasm_bindgen(js_name = readFreeSurferLabel)]
pub fn read_freesurfer_label(bytes: &[u8]) -> Result<JsValue> {
    let text = std::str::from_utf8(bytes).map_err(|_| fail(Error::format("FreeSurfer", "label is not UTF-8 text")))?;
    let label = freesurfer::read_label(text).map_err(fail)?;
    Ok(object(vec![
        ("vertices", Uint32Array::from(label.vertices.as_slice()).into()),
        ("coordinates", flat3(&label.coordinates)),
        ("values", f64s(&label.values)),
    ]))
}

#[wasm_bindgen(js_name = readAnatomy)]
#[allow(clippy::too_many_arguments)]
pub fn read_anatomy(
    white: &[u8],
    pial: &[u8],
    inflated: &[u8],
    sphere: &[u8],
    curv: &[u8],
    area: &[u8],
    thickness: Option<Vec<u8>>,
) -> Result<JsValue> {
    let files = freesurfer::AnatomyFiles { white, pial, inflated, sphere, curv, area, thickness: thickness.as_deref() };
    let anatomy = freesurfer::read_anatomy(&files).map_err(fail)?;
    let thickness = anatomy.thickness.as_deref().map_or(JsValue::NULL, f64s);
    Ok(object(vec![
        ("white", surface_object(&anatomy.white)),
        ("pial", flat3(&anatomy.pial)),
        ("inflated", flat3(&anatomy.inflated)),
        ("sphere", flat3(&anatomy.sphere)),
        ("curvature", f64s(&anatomy.curvature)),
        ("area", f64s(&anatomy.area)),
        ("thickness", thickness),
        ("normals", flat3(&anatomy.normals())),
    ]))
}

#[wasm_bindgen(js_name = readMat)]
pub fn read_mat(bytes: &[u8]) -> Result<JsValue> {
    let file = mat::read(bytes).map_err(fail)?;
    let entries: Vec<(&str, JsValue)> = file
        .variables
        .iter()
        .map(|(name, array)| {
            let class = match array.class {
                mat::MatClass::Double => "double",
                mat::MatClass::Single => "single",
                mat::MatClass::Int8 => "int8",
                mat::MatClass::Uint8 => "uint8",
                mat::MatClass::Int16 => "int16",
                mat::MatClass::Uint16 => "uint16",
                mat::MatClass::Int32 => "int32",
                mat::MatClass::Uint32 => "uint32",
                mat::MatClass::Int64 => "int64",
                mat::MatClass::Uint64 => "uint64",
                mat::MatClass::Logical => "logical",
            };
            let dims: Array = array.dims.iter().map(|dim| JsValue::from(*dim as f64)).collect();
            let value = object(vec![("class", JsValue::from_str(class)), ("dims", dims.into()), ("data", f64s(&array.data))]);
            (name.as_str(), value)
        })
        .collect();
    Ok(object(entries))
}

#[wasm_bindgen(js_name = readOldSchoolHrf)]
pub fn read_old_school_hrf(bytes: &[u8]) -> Result<Vec<f64>> {
    mat::read_old_school_hrf(bytes).map(Vec::from).map_err(fail)
}

// Apertures

/// Stimulus apertures in wasm memory, sparse per frame.
#[wasm_bindgen]
pub struct Apertures {
    inner: CoreApertures,
}

/// `serialize` layout, little-endian: the magic, then u32 version, width, height,
/// volumes and a conditions flag (0 or 1); `width * height` (x, y) f64 pairs; with the
/// flag, one f64 condition label per volume; then per frame a u32 count followed by
/// that many u32 pixel indices and that many f64 values.
const APERTURES_MAGIC: &[u8; 8] = b"SAMSRFAP";
const APERTURES_VERSION: u32 = 1;

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8]> {
        let end = self.position.checked_add(count).filter(|end| *end <= self.bytes.len());
        let end = end.ok_or_else(|| fail(Error::format("apertures", "serialised apertures are truncated")))?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn count(&mut self) -> Result<usize> {
        self.u32().map(|value| value as usize)
    }

    fn f64s(&mut self, count: usize) -> Result<Vec<f64>> {
        let bytes = self.take(count.checked_mul(8).ok_or_else(|| shape("serialised apertures are too large".into()))?)?;
        Ok(bytes.as_chunks::<8>().0.iter().map(|chunk| f64::from_le_bytes(*chunk)).collect())
    }

    fn u32s(&mut self, count: usize) -> Result<Vec<u32>> {
        let bytes = self.take(count.checked_mul(4).ok_or_else(|| shape("serialised apertures are too large".into()))?)?;
        Ok(bytes.as_chunks::<4>().0.iter().map(|chunk| u32::from_le_bytes(*chunk)).collect())
    }
}

fn apertures_format(message: impl Into<String>) -> JsError {
    fail(Error::format("apertures", message))
}

#[wasm_bindgen]
impl Apertures {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.inner.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.inner.height
    }

    #[wasm_bindgen(getter)]
    pub fn volumes(&self) -> usize {
        self.inner.volumes()
    }

    #[wasm_bindgen(js_name = scaledXy)]
    pub fn scaled_xy(&self, scaling_factor: f64) -> Vec<f64> {
        self.inner.scaled_xy(scaling_factor).into_iter().flatten().collect()
    }

    #[wasm_bindgen(js_name = toDense)]
    pub fn to_dense(&self) -> Vec<f64> {
        self.inner.to_dense()
    }

    pub fn serialize(&self) -> Vec<u8> {
        let apertures = &self.inner;
        let mut out = Vec::new();
        out.extend_from_slice(APERTURES_MAGIC);
        let header = [
            APERTURES_VERSION,
            apertures.width as u32,
            apertures.height as u32,
            apertures.volumes() as u32,
            u32::from(apertures.conditions.is_some()),
        ];
        out.extend(header.iter().flat_map(|value| value.to_le_bytes()));
        out.extend(apertures.xy.iter().flatten().flat_map(|value| value.to_le_bytes()));
        if let Some(conditions) = &apertures.conditions {
            out.extend(conditions.iter().flat_map(|value| value.to_le_bytes()));
        }
        for frame in &apertures.frames {
            out.extend((frame.indices.len() as u32).to_le_bytes());
            out.extend(frame.indices.iter().flat_map(|value| value.to_le_bytes()));
            out.extend(frame.values.iter().flat_map(|value| value.to_le_bytes()));
        }
        out
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Apertures> {
        let mut reader = Reader { bytes, position: 0 };
        if reader.take(APERTURES_MAGIC.len())? != APERTURES_MAGIC {
            return Err(apertures_format("not serialised SamSrf apertures"));
        }
        let version = reader.u32()?;
        if version != APERTURES_VERSION {
            return Err(apertures_format(format!("serialisation version {version} is not supported (expected {APERTURES_VERSION})")));
        }
        let width = reader.count()?;
        let height = reader.count()?;
        let volumes = reader.count()?;
        let has_conditions = match reader.u32()? {
            0 => false,
            1 => true,
            flag => return Err(apertures_format(format!("conditions flag {flag} is not 0 or 1"))),
        };
        let pixels = width.checked_mul(height).ok_or_else(|| apertures_format("aperture size overflows"))?;
        let xy = reader.f64s(pixels.checked_mul(2).ok_or_else(|| apertures_format("aperture size overflows"))?)?;
        let xy = xy.as_chunks::<2>().0.to_vec();
        let conditions = if has_conditions { Some(reader.f64s(volumes)?) } else { None };
        let mut frames = Vec::with_capacity(volumes.min(bytes.len()));
        for volume in 0..volumes {
            let count = reader.count()?;
            let indices = reader.u32s(count)?;
            let values = reader.f64s(count)?;
            let ascending = indices.windows(2).all(|pair| pair[0] < pair[1]);
            if !ascending || indices.last().is_some_and(|last| *last as usize >= pixels) {
                return Err(apertures_format(format!("frame {} has pixel indices outside 0..{pixels} or out of order", volume + 1)));
            }
            frames.push(Frame { indices, values });
        }
        if reader.position != bytes.len() {
            return Err(apertures_format("serialised apertures have trailing bytes"));
        }
        Ok(Apertures { inner: CoreApertures { width, height, frames, xy, conditions } })
    }
}

#[wasm_bindgen(js_name = readApertures)]
pub fn read_apertures(bytes: &[u8], format: &str) -> Result<Apertures> {
    let inner = match format {
        "mat" => mat::read_apertures(bytes),
        "nii" => nifti_aps::read_apertures(bytes),
        "gif" => gif_aps::read_apertures(bytes),
        _ => return Err(JsError::new(&format!("aperture format {format:?} is not 'mat', 'nii' or 'gif'"))),
    };
    inner.map(|inner| Apertures { inner }).map_err(fail)
}

// Model and expressions

/// The model as JSON. Serde's default form of `HrfSpec` is rewritten to
/// `{ type, values }` / `{ type, file }` here because an internally tagged enum
/// cannot carry the core's tuple variants.
#[wasm_bindgen(js_name = parseModel)]
pub fn parse_model(kind: &str, json: &str) -> Result<String> {
    let analysis = AnalysisKind::parse(kind).ok_or_else(|| JsError::new(&format!("analysis kind {kind:?} is not 'prf', 'rc' or 'cf'")))?;
    let parsed = model::parse_model_json(analysis, json).map_err(fail)?;
    let mut value = serde_json::to_value(&parsed).expect("models serialise");
    if let Some(spec) = value.get_mut("hrf") {
        *spec = match spec.take() {
            serde_json::Value::String(kind) => serde_json::json!({ "type": kind }),
            serde_json::Value::Object(variant) => {
                let (kind, inner) = variant.into_iter().next().expect("a tagged HRF variant");
                let field = if kind == "vector" { "values" } else { "file" };
                let mut rewritten = serde_json::Map::new();
                rewritten.insert("type".into(), kind.into());
                rewritten.insert(field.into(), inner);
                rewritten.into()
            }
            other => other,
        };
    }
    Ok(value.to_string())
}

/// `args` arrive flattened: the shape of argument `i` is `rows[i] x cols[i]` and its
/// column-major values follow the previous argument's in `data`.
#[wasm_bindgen(js_name = evaluateExpression)]
pub fn evaluate_expression(source: &str, rows: &[u32], cols: &[u32], data: &[f64]) -> Result<JsValue> {
    let function = AnonymousFunction::parse(source).map_err(fail)?;
    let mut args = Vec::with_capacity(rows.len());
    let mut offset = 0;
    for (&rows, &cols) in rows.iter().zip(cols) {
        let (rows, cols) = (rows as usize, cols as usize);
        let end = offset + rows * cols;
        let values = data.get(offset..end).ok_or_else(|| shape("expression arguments hold fewer values than their shapes".into()))?;
        args.push(Value { rows, cols, data: values.to_vec() });
        offset = end;
    }
    if offset != data.len() {
        return Err(shape("expression arguments hold more values than their shapes".into()));
    }
    let result = function.evaluate(&args).map_err(fail)?;
    Ok(object(vec![
        ("rows", JsValue::from(result.rows as f64)),
        ("cols", JsValue::from(result.cols as f64)),
        ("data", f64s(&result.data)),
    ]))
}

// pRF

/// `source` is a profile function name (`prf_gaussian_rf`) called with the parameters
/// as scalars, or an anonymous function (`@(P,ApWidth) ...`) called as `f(P, domain)`.
fn profile(source: &str, params: &[f64], domain: Value) -> Result<Vec<f64>> {
    let result = if source.trim_start().starts_with('@') {
        let function = AnonymousFunction::parse(source).map_err(fail)?;
        function.evaluate(&[Value::column(params.to_vec()), domain])
    } else {
        let mut args: Vec<Value> = params.iter().map(|value| Value::scalar(*value)).collect();
        args.push(domain);
        prf::call(source, &args)
    };
    result.map(|value| value.data).map_err(fail)
}

#[wasm_bindgen(js_name = prfProfileXy)]
pub fn prf_profile_xy(source: &str, params: &[f64], xy: &[f64]) -> Result<Vec<f64>> {
    profile(source, params, xy_value(xy)?)
}

#[wasm_bindgen(js_name = prfProfileGrid)]
pub fn prf_profile_grid(source: &str, params: &[f64], screen_width: f64) -> Result<Vec<f64>> {
    profile(source, params, Value::scalar(screen_width))
}

#[wasm_bindgen(js_name = predictTimecourse)]
pub fn predict_timecourse(rfp: &[f64], apertures: &Apertures) -> Vec<f64> {
    prf::predict_timecourse(rfp, &apertures.inner)
}

#[wasm_bindgen]
pub fn pearson(x: &[f64], y: &[f64]) -> f64 {
    prf::pearson(x, y)
}

/// `kernel` is the HRF; without one, `fit_tr` is the TR of the fitted HRF.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn errfun(
    source: &str,
    apertures: &Apertures,
    xy: &[f64],
    kernel: Option<Vec<f64>>,
    fit_tr: Option<f64>,
    params: &[f64],
    observed: &[f64],
    downsampling: usize,
    css_nonlinearity: bool,
) -> Result<f64> {
    let function = AnonymousFunction::parse(source).map_err(fail)?;
    let hrf = match (kernel, fit_tr) {
        (Some(kernel), None) => hrf::ErrfunHrf::Kernel(kernel),
        (None, Some(tr)) => hrf::ErrfunHrf::Fit { tr },
        _ => return Err(JsError::new("errfun takes either an HRF kernel or { fit: tr }")),
    };
    if downsampling == 0 {
        return Err(shape("downsampling must be a positive integer".into()));
    }
    let xy = points(xy)?;
    prf::errfun(&function, &apertures.inner, &xy, &hrf, params, observed, downsampling, css_nonlinearity).map_err(fail)
}

// HRF

#[wasm_bindgen(js_name = hrfDoublegamma)]
pub fn hrf_doublegamma(tr: f64, p: &[f64]) -> Vec<f64> {
    hrf::doublegamma(tr, p)
}

#[wasm_bindgen(js_name = hrfSpmCanonical)]
pub fn hrf_spm_canonical(tr: f64) -> Vec<f64> {
    hrf::spm_canonical(tr)
}

#[wasm_bindgen(js_name = hrfDeHaas)]
pub fn hrf_de_haas(tr: f64) -> Vec<f64> {
    hrf::de_haas(tr)
}

#[wasm_bindgen(js_name = hrfOldSchool)]
pub fn hrf_old_school(tr: f64, fp: &[f64]) -> Result<Vec<f64>> {
    let fp: [f64; 4] = fp.try_into().map_err(|_| shape(format!("fP has {} values; an old-school HRF has 4", fp.len())))?;
    Ok(hrf::old_school(tr, fp))
}

#[wasm_bindgen(js_name = hrfConvolve)]
pub fn hrf_convolve(y: &[f64], kernel: &[f64], downsampling: usize) -> Result<Vec<f64>> {
    if downsampling == 0 {
        return Err(shape("downsampling must be a positive integer".into()));
    }
    Ok(hrf::convolve(y, kernel, downsampling))
}

/// Resolves a parsed model's `hrf` object (`type` plus `values` or `file`).
#[wasm_bindgen(js_name = hrfResolve)]
pub fn hrf_resolve(kind: &str, values: Option<Vec<f64>>, file: Option<String>, tr: f64) -> Result<JsValue> {
    let spec = match (kind, values, file) {
        ("spmCanonical", None, None) => HrfSpec::SpmCanonical,
        ("none", None, None) => HrfSpec::None,
        ("deHaas", None, None) => HrfSpec::DeHaas,
        ("fit", None, None) => HrfSpec::Fit,
        ("vector", Some(values), None) => HrfSpec::Vector(values),
        ("oldSchoolFile", None, Some(file)) => HrfSpec::OldSchoolFile(file),
        ("vertexWiseFile", None, Some(file)) => HrfSpec::VertexWiseFile(file),
        _ => return Err(JsError::new(&format!("HRF spec of type {kind:?} is not one parseModel writes"))),
    };
    Ok(match hrf::resolve(&spec, tr).map_err(fail)? {
        hrf::ResolvedHrf::Kernel(kernel) => object(vec![("type", "kernel".into()), ("values", f64s(&kernel))]),
        hrf::ResolvedHrf::None => object(vec![("type", "none".into())]),
        hrf::ResolvedHrf::Fit => object(vec![("type", "fit".into())]),
    })
}

// Preprocessing

/// Streams runs into the combined, normalised time courses of the kept vertices.
#[wasm_bindgen]
pub struct RunAccumulator {
    inner: Option<preprocess::RunAccumulator>,
}

fn finished() -> JsError {
    JsError::new("the RunAccumulator has already finished")
}

fn optional_u32s(values: Option<&[u32]>) -> JsValue {
    values.map_or(JsValue::NULL, |values| Uint32Array::from(values).into())
}

#[wasm_bindgen]
impl RunAccumulator {
    #[wasm_bindgen(constructor)]
    pub fn new(
        total_vertices: usize,
        keep: Option<Vec<u32>>,
        normalise: &str,
        combine: &str,
        noise_ceiling: bool,
        global_signal: bool,
    ) -> Result<RunAccumulator> {
        let normalise = match normalise {
            "none" => Normalise::None,
            "detrend" => Normalise::Detrend,
            "zscore" => Normalise::DetrendZscore,
            _ => return Err(JsError::new(&format!("normalise {normalise:?} is not 'none', 'detrend' or 'zscore'"))),
        };
        let combine = match combine {
            "average" => Combine::Average { noise_ceiling },
            "concatenate" => Combine::Concatenate,
            _ => return Err(JsError::new(&format!("combine {combine:?} is not 'average' or 'concatenate'"))),
        };
        let kept = keep.map_or(VertexSelection::All, VertexSelection::from_indices);
        let options = PreprocessOptions { normalise, combine, global_signal };
        Ok(RunAccumulator { inner: Some(preprocess::RunAccumulator::new(total_vertices, kept, options)) })
    }

    #[wasm_bindgen(js_name = pushRun)]
    pub fn push_run(&mut self, run: &Run) -> Result<()> {
        self.inner.as_mut().ok_or_else(finished)?.push_run(&run.inner).map_err(fail)
    }

    pub fn finish(&mut self) -> Result<JsValue> {
        let Preprocessed { kept, total_vertices, runs, data, noise_ceiling, global_signal } =
            self.inner.take().ok_or_else(finished)?.finish().map_err(fail)?;
        let kept = match &kept {
            VertexSelection::All => JsValue::NULL,
            VertexSelection::Indices(indices) => optional_u32s(Some(indices)),
        };
        Ok(object(vec![
            ("kept", kept),
            ("totalVertices", JsValue::from(total_vertices as f64)),
            ("runs", JsValue::from(runs as f64)),
            ("volumes", JsValue::from(data.volumes as f64)),
            ("vertices", JsValue::from(data.vertices as f64)),
            ("data", f64s(&data.data)),
            ("noiseCeiling", noise_ceiling.as_deref().map_or(JsValue::NULL, f64s)),
            ("globalSignal", global_signal.as_deref().map_or(JsValue::NULL, f64s)),
        ]))
    }
}

#[wasm_bindgen]
pub fn detrend(mut x: Vec<f64>) -> Vec<f64> {
    preprocess::detrend(&mut x);
    x
}

#[wasm_bindgen]
pub fn zscore(mut x: Vec<f64>) -> Vec<f64> {
    preprocess::zscore(&mut x);
    x
}

#[wasm_bindgen(js_name = noiseCeiling)]
pub fn noise_ceiling(odd: &[f64], even: &[f64]) -> Result<f64> {
    if odd.len() != even.len() {
        return Err(shape(format!("odd and even means differ in length ({} and {})", odd.len(), even.len())));
    }
    Ok(preprocess::noise_ceiling(odd, even))
}

#[wasm_bindgen(js_name = removeNoise)]
pub fn remove_noise(volumes: usize, vertices: usize, data: Vec<f64>, covariates: &[f64], n_covariates: usize) -> Result<Vec<f64>> {
    if data.len() != volumes * vertices {
        return Err(shape(format!("data holds {} values, not {volumes} volumes x {vertices} vertices", data.len())));
    }
    let mut series = TimeSeries { volumes, vertices, data };
    preprocess::remove_noise(&mut series, covariates, n_covariates).map_err(fail)?;
    Ok(series.data)
}

// Export

fn export_convention(name: Option<String>) -> Result<export::ExportConvention> {
    match name.as_deref().unwrap_or("samsrf-10.4") {
        "samsrf-10.4" => Ok(export::ExportConvention::Geometric),
        "samsrfx-10.003" => Ok(export::ExportConvention::SamSrfX10003),
        other => Err(shape(format!("unknown export convention {other}"))),
    }
}

fn maps(values: Vec<String>, vertices: usize, data: Vec<f64>) -> Result<mapset::Maps> {
    if data.len() != values.len() * vertices {
        return Err(shape(format!("maps hold {} values, not {} rows x {vertices} vertices", data.len(), values.len())));
    }
    Ok(mapset::Maps { values, vertices, data })
}

#[wasm_bindgen(js_name = exportGiis)]
pub fn export_giis(values: Vec<String>, vertices: usize, data: Vec<f64>, prefix: &str, selection: Option<Vec<String>>, convention: Option<String>) -> Result<Array> {
    let maps = maps(values, vertices, data)?;
    let selection = selection.map_or(export::ExportSelection::All, export::ExportSelection::Named);
    Ok(export::export_giis_with_convention(&maps, prefix, &selection, export_convention(convention)?)
        .into_iter()
        .map(|file| object(vec![("name", JsValue::from_str(&file.name)), ("bytes", Uint8Array::from(file.bytes.as_slice()).into())]))
        .collect())
}

#[wasm_bindgen(js_name = writeGiftiMap)]
pub fn write_gifti_map(values: &[f64]) -> Vec<u8> {
    gifti::write_map(values)
}

#[wasm_bindgen(js_name = polarAndEccentricity)]
pub fn polar_and_eccentricity(values: Vec<String>, vertices: usize, data: Vec<f64>, convention: Option<String>) -> Result<JsValue> {
    let maps = maps(values, vertices, data)?;
    Ok(export::polar_and_eccentricity_with_convention(&maps, export_convention(convention)?).map_or(JsValue::NULL, |(polar, eccentricity)| {
        object(vec![("polar", f64s(&polar)), ("eccentricity", f64s(&eccentricity))])
    }))
}

// Analyses

#[wasm_bindgen(js_name = readBensonTemplate)]
pub fn read_benson_template(bytes: &[u8], right_hemisphere: bool) -> Result<JsValue> {
    let maps = template::read_benson_gifti(bytes, right_hemisphere).map_err(fail)?;
    Ok(maps_object(&maps))
}

fn maps_object(maps: &mapset::Maps) -> JsValue {
    let values: Array = maps.values.iter().map(|value| JsValue::from_str(value)).collect();
    object(vec![
        ("values", values.into()),
        ("vertices", JsValue::from(maps.vertices as f64)),
        ("data", f64s(&maps.data)),
    ])
}

fn surface_from(vertices: &[f64], faces: &[u32]) -> Result<Surface> {
    if !vertices.len().is_multiple_of(3) || !faces.len().is_multiple_of(3) {
        return Err(shape("surface vertices and faces must come in triples".into()));
    }
    let vertices = vertices.as_chunks::<3>().0.to_vec();
    let faces = Faces::Triangles(faces.as_chunks::<3>().0.to_vec());
    Ok(Surface { vertices, faces })
}

fn call_progress(progress: &Option<js_sys::Function>, done: usize, total: usize) {
    if let Some(function) = progress {
        let _ = function.call2(&JsValue::NULL, &JsValue::from(done as f64), &JsValue::from(total as f64));
    }
}

/// One prepared analysis; see packages/samsrf/README.md for `createJob`.
#[wasm_bindgen]
pub struct Job {
    inner: job::Job,
}

#[wasm_bindgen(js_name = createJob)]
#[allow(clippy::too_many_arguments)]
pub fn create_job(
    kind: &str,
    model_json: &str,
    apertures: Option<Vec<u8>>,
    hrf_mode: &str,
    hrf_kernel: Option<Vec<f64>>,
    volumes: usize,
    kept: Vec<u32>,
    courses: Vec<f64>,
    roi: Option<Vec<u32>>,
    noise_ceiling: Option<Vec<f64>>,
    global_signal: Option<Vec<f64>>,
    seed_vertices: Option<Vec<u32>>,
    template_values: Option<Vec<String>>,
    template_data: Option<Vec<f64>>,
    surface_vertices: Option<Vec<f64>>,
    surface_faces: Option<Vec<u32>>,
    area: Option<Vec<f64>>,
    seed_fine_fit_values: Option<Vec<String>>,
    seed_fine_fit_data: Option<Vec<f64>>,
    total_vertices: usize,
    progress: Option<js_sys::Function>,
) -> Result<Job> {
    let analysis = AnalysisKind::parse(kind).ok_or_else(|| JsError::new(&format!("analysis kind {kind:?} is not 'prf', 'rc' or 'cf'")))?;
    let model = model::parse_model_json(analysis, model_json).map_err(fail)?;
    let apertures = apertures.map(|bytes| Apertures::deserialize(&bytes).map(|apertures| apertures.inner)).transpose()?;
    let hrf = match hrf_mode {
        "model" => None,
        "none" => Some(hrf::ResolvedHrf::None),
        "fit" => Some(hrf::ResolvedHrf::Fit),
        "kernel" => Some(hrf::ResolvedHrf::Kernel(hrf_kernel.ok_or_else(|| JsError::new("hrf kernel values are missing"))?)),
        other => return Err(JsError::new(&format!("hrf mode {other:?} is not 'model', 'none', 'fit' or 'kernel'"))),
    };
    if courses.len() != volumes * kept.len() {
        return Err(shape(format!("{} course values are not {volumes} volumes x {} kept vertices", courses.len(), kept.len())));
    }
    let data = TimeSeries { volumes, vertices: kept.len(), data: courses };
    let seed = match (seed_vertices, template_values, template_data) {
        (Some(vertices), Some(values), Some(data)) => Some(job::SeedInputs { vertices, template: maps(values, total_vertices, data)? }),
        (None, _, _) => None,
        _ => return Err(shape("a seed region needs its vertices and the template maps".into())),
    };
    let surface = match (surface_vertices, surface_faces) {
        (Some(vertices), Some(faces)) => Some(surface_from(&vertices, &faces)?),
        (None, None) => None,
        _ => return Err(shape("a surface needs both vertices and faces".into())),
    };
    let seed_fine_fit = match (seed_fine_fit_values, seed_fine_fit_data) {
        (Some(values), Some(data)) => Some(maps(values, total_vertices, data)?),
        (None, None) => None,
        _ => return Err(shape("seed fine-fit maps need values and data".into())),
    };
    let inputs = job::JobInputs { model, apertures, hrf, data, kept, roi, noise_ceiling, global_signal, seed, surface, area, seed_fine_fit, total_vertices };
    let inner = job::Job::prepare(inputs, &mut |done, total| call_progress(&progress, done, total)).map_err(fail)?;
    Ok(Job { inner })
}

#[wasm_bindgen]
impl Job {
    #[wasm_bindgen(getter, js_name = vertexCount)]
    pub fn vertex_count(&self) -> usize {
        self.inner.vertex_count()
    }

    /// The analysed vertices in label order.
    pub fn analysed(&self) -> Uint32Array {
        Uint32Array::from(self.inner.analysed())
    }

    pub fn values(&self) -> Array {
        self.inner.values().iter().map(|value| JsValue::from_str(value)).collect()
    }

    #[wasm_bindgen(getter, js_name = outSuffix)]
    pub fn out_suffix(&self) -> String {
        self.inner.out_suffix()
    }

    #[wasm_bindgen(getter, js_name = modelName)]
    pub fn model_name(&self) -> String {
        self.inner.model_name().to_string()
    }

    pub fn run(&self, start: usize, end: usize, progress: Option<js_sys::Function>) -> Result<Vec<u8>> {
        let total = end.saturating_sub(start);
        let partial = self.inner.run(start, end, &mut |done| call_progress(&progress, done, total)).map_err(fail)?;
        Ok(partial.to_bytes())
    }

    pub fn merge(&self, partials: Array) -> Result<JsValue> {
        let mut parsed = Vec::with_capacity(partials.length() as usize);
        for value in partials.iter() {
            let bytes = Uint8Array::new(&value).to_vec();
            parsed.push(job::Partial::from_bytes(&bytes).map_err(fail)?);
        }
        let set = self.inner.merge(&parsed).map_err(fail)?;
        let analysed = match &set.analysed {
            VertexSelection::All => JsValue::NULL,
            VertexSelection::Indices(indices) => optional_u32s(Some(indices)),
        };
        Ok(object(vec![
            ("maps", maps_object(&set.maps)),
            ("raw", set.raw.as_ref().map_or(JsValue::NULL, maps_object)),
            ("analysed", analysed),
        ]))
    }
}
