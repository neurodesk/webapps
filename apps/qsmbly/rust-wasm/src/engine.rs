//! QSMxT's run engine in the browser.
//!
//! The page plans a run ([`plan_wasm`], or [`Engine::plan`] once a scan is loaded), hands over
//! the weights of the deep-learning models the plan names ([`provide_weights_wasm`]), and runs it
//! ([`Engine::run`]). The plan, the steps, their order, their cache keys and every computation
//! are `qsmxt run`'s own, from `qsmxt-engine`; nothing here decides anything about the run.
//!
//! The volumes stay in the page, outside the WASM heap ([`PageVolumes`]): the heap holds only the
//! step being computed. Real-valued outputs are kept as float32, the precision `qsmxt run` keeps
//! them at in its files, so every step reads the values `qsmxt run` would read back.
//!
//! Volumes are named by their `qsmxt-engine` [`Item`], written as Rust writes it
//! (`AcquiredPhase(1)`, `FieldPpm`, `LocalField(Main)`, `Chi`, ...): [`item_key`].

use std::cell::RefCell;

use js_sys::{Float32Array, Float64Array, Function, Object, Reflect, Uint8Array};
use qsmxt_engine::inputs::{ScanInputs, ScanReport};
use qsmxt_engine::masking::MaskSection;
use qsmxt_engine::observe::{Observer, StageEvent, VolumeData};
use qsmxt_engine::qsm_core;
use qsmxt_engine::qsm_core::pipeline::VolumeRef;
use qsmxt_engine::scan::{QsmSidecar, RunMetadata, ScanFacts};
use qsmxt_engine::stages::mask::{MaskInputs, Upto};
use qsmxt_engine::store::{Geometry, Header, Item, MemoryStore, Recorded, Supplied, Volumes};
use qsmxt_engine::{EngineError, PipelineConfig};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::js_err;

/// The name a volume is kept under in the page ([`Item::key`]).
pub fn item_key(item: &Item) -> String {
    item.key()
}

/// The name the working-grid version of `item` is kept aside under while `item` holds its version on
/// the acquired grid.
pub fn aside_key(item: &Item) -> String {
    format!("WorkingGrid:{}", item.key())
}

/// A JS object's method `name`, if it has one.
fn method(obj: &Object, name: &str) -> Result<Option<Function>, JsValue> {
    let value = Reflect::get(obj, &JsValue::from_str(name))?;
    Ok(value.dyn_into::<Function>().ok())
}

/// A JS object's method `name`, which it must have.
fn required(obj: &Object, name: &str, what: &str) -> Result<Function, JsValue> {
    method(obj, name)?.ok_or_else(|| js_err(format!("{what} has no {name}() method")))
}

/// What a thrown JS value says.
fn js_message(e: &JsValue) -> String {
    e.dyn_ref::<js_sys::Error>()
        .map(|e| String::from(e.message()))
        .or_else(|| e.as_string())
        .unwrap_or_else(|| format!("{e:?}"))
}

// ============================================================================
// Scan facts and plans
// ============================================================================

fn parse_config(config_json: &str) -> Result<PipelineConfig, JsValue> {
    crate::settings::parse_config(config_json).map_err(js_err)
}

/// Each echo's sidecar, from a JSON array of BIDS sidecar objects (`EchoTime` in seconds,
/// `MagneticFieldStrength` in tesla, and whatever else the scan's sidecars hold, e.g. `B0_dir`).
fn parse_sidecars(sidecars_json: &str) -> Result<Vec<QsmSidecar>, JsValue> {
    let values: Vec<serde_json::Value> = serde_json::from_str(sidecars_json)
        .map_err(|e| js_err(format!("sidecars must be a JSON array of objects: {e}")))?;
    values
        .iter()
        .enumerate()
        .map(|(n, v)| {
            QsmSidecar::from_json(v)
                .map_err(|field| js_err(format!("echo {}'s sidecar has no {field}", n + 1)))
        })
        .collect()
}

/// The facts of a magnitude/phase scan from its first echo's matrix size and every echo's sidecar
/// (`ScanFacts::from_sidecars`), as JSON.
#[wasm_bindgen]
pub fn scan_facts_wasm(
    dims: &[usize],
    sidecars_json: &str,
    has_magnitude: bool,
) -> Result<String, JsValue> {
    let &[nx, ny, nz] = dims else {
        return Err(js_err("dims must have three elements"));
    };
    let facts =
        ScanFacts::from_sidecars((nx, ny, nz), &parse_sidecars(sidecars_json)?, has_magnitude)
            .map_err(js_err)?;
    serde_json::to_string(&facts).map_err(js_err)
}

fn parse_scan_inputs(inputs_json: &str) -> Result<ScanInputs, String> {
    serde_json::from_str(inputs_json).map_err(|e| format!("the scan inputs are not valid: {e}"))
}

/// The facts of a scan from what the page holds of it (`ScanInputs` JSON: each echo's phase and
/// magnitude header geometry and sidecar, and the values the user typed in), as
/// `ScanInputs::facts` gives them (`ScanReport` JSON: the facts, each fact with its source, the
/// input problems, and the sidecars a run reads).
pub fn scan_report(inputs_json: &str) -> Result<String, String> {
    serde_json::to_string(&parse_scan_inputs(inputs_json)?.facts()).map_err(|e| e.to_string())
}

/// [`scan_report`].
#[wasm_bindgen]
pub fn scan_report_wasm(inputs_json: &str) -> Result<String, JsValue> {
    scan_report(inputs_json).map_err(js_err)
}

/// A NIfTI file's grid (Geometry JSON: `dims`, `voxel_size`, `affine`), read by qsm-core as `qsmxt
/// run` reads its files.
#[wasm_bindgen]
pub fn nifti_geometry_wasm(nifti: &[u8]) -> Result<String, JsValue> {
    let file = qsm_core::io::load_nifti(nifti).map_err(js_err)?;
    let geometry = Geometry {
        dims: file.dims,
        voxel_size: file.voxel_size,
        affine: file.affine,
    };
    serde_json::to_string(&geometry).map_err(js_err)
}

/// The threads the run worker computes a plan on, of the page's `threads`: a plan with networks
/// runs on the deep-learning bundle, whose pool has 4 threads (js/next/engine/run-worker.js).
pub(crate) const DL_THREADS: usize = 4;

/// A run's plan as the browser runs it on `threads` threads: its memory figures are for the WASM
/// heap, with the volumes kept in the page (`MemoryProfile::browser`), and a step the heap
/// cannot hold is among its warnings.
pub(crate) fn browser_plan(
    config: &PipelineConfig,
    facts: &ScanFacts,
    threads: usize,
) -> qsmxt_engine::plan::Plan {
    use qsmxt_engine::memory::MemoryProfile;
    let plan = qsmxt_engine::plan::plan_for(config, facts, &MemoryProfile::browser(threads.max(1)));
    if plan.models.is_empty() || threads == DL_THREADS {
        return plan;
    }
    qsmxt_engine::plan::plan_for(config, facts, &MemoryProfile::browser(DL_THREADS))
}

/// A plan as JSON (`qsmxt_engine::plan::Plan`, as [`browser_plan`] makes it on `threads`): each
/// step's `name` (`mask`, `invert-reliable`, ...: the name its events and cache use), `label`,
/// `algorithm` and `algorithm_label`, `memory_bytes`, and the items it `reads` and `outputs` by
/// their keys ([`item_key`]); `items` says what each of those is (`Item::meta`, with its `key`),
/// in the order they first appear.
pub(crate) fn plan_json(
    config: &PipelineConfig,
    facts: &ScanFacts,
    threads: usize,
) -> Result<String, String> {
    let plan = browser_plan(config, facts, threads);
    let mut json = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
    let mut items: Vec<Item> = Vec::new();
    if let Some(steps) = json.get_mut("steps").and_then(|s| s.as_array_mut()) {
        for (value, step) in steps.iter_mut().zip(&plan.steps) {
            for (field, list) in [("reads", &step.reads), ("outputs", &step.outputs)] {
                value[field] = list.iter().map(item_key).collect::<Vec<_>>().into();
                items.extend(
                    list.iter()
                        .filter(|i| !items.contains(i))
                        .copied()
                        .collect::<Vec<_>>(),
                );
            }
        }
    }
    json["items"] = items
        .iter()
        .map(crate::settings::item_info)
        .collect::<Vec<_>>()
        .into();
    Ok(json.to_string())
}

/// What `qsmxt run` will do with `config` (PipelineConfig JSON) on the scan `facts` (ScanFacts
/// JSON) describes: its steps in order, the deep-learning models they need (`models`: the
/// weights to provide before running), each step's memory and the run's peak in the WASM heap on
/// `threads` threads (4 when not given), what the data cannot produce or the heap cannot hold
/// (`check`), and notes. Pure: it reads nothing but its arguments.
#[wasm_bindgen]
pub fn plan_wasm(
    config_json: &str,
    facts_json: &str,
    threads: Option<u32>,
) -> Result<String, JsValue> {
    let facts = crate::settings::parse_facts(facts_json).map_err(js_err)?;
    plan_json(
        &parse_config(config_json)?,
        &facts,
        threads.map_or(DL_THREADS, |t| t as usize),
    )
    .map_err(js_err)
}

/// Hand over a deep-learning weight file (by its name in the model registry), for every run in
/// this module to use. Its SHA-256 is checked against the registry.
#[wasm_bindgen]
pub fn provide_weights_wasm(file_name: &str, bytes: Vec<u8>) -> Result<(), JsValue> {
    qsm_core::models::provide_weights(file_name, bytes).map_err(js_err)
}

// ============================================================================
// Volumes in the page
// ============================================================================

/// A `MemoryStore`'s volumes, kept by the page: a JS object with
///
/// - `has(key)`: whether a volume is kept under `key` ([`item_key`]);
/// - `get(key)`: the volume, as a `Float32Array` or `Float64Array` (real), a `Uint8Array` (mask),
///   or `{ nifti: Uint8Array }` (an input as its NIfTI file, `.nii` or `.nii.gz`), or `undefined`;
/// - `put(key, volume)`: keep a step's output (`Float32Array` or `Uint8Array`);
/// - `copy(from, to)`: keep `from`'s volume under `to` as well (`true` if there was one);
/// - `remove(key)`: forget it;
/// - optionally `begin(grid)`: the run's grid (`RunMetadata` JSON) is known;
/// - optionally `record(recorded)`: what the engine has recorded besides the volumes changed
///   (`Recorded` JSON: completed steps and their keys, the load step's grid, reports, the grids of
///   volumes not on the run's). Kept beside the volumes, it lets a new [`Engine`] over them (after
///   the worker was terminated, say) carry on with every completed step cached.
///
/// An output returned to the acquired grid replaces its working-grid version, which is kept aside
/// under [`aside_key`] (`WorkingGrid:Chi`, ...), through `copy` and `remove`, until a later run
/// needs it back.
///
/// Inputs given as NIfTI files are decoded by qsm-core, as `qsmxt run` decodes its files. One whose
/// values are all exact in float32 keeps its decoded values beside the file (`decoded`, a
/// `Float32Array`), so it is decoded once.
pub struct PageVolumes {
    this: JsValue,
    has: Function,
    get: Function,
    put: Function,
    copy: Function,
    remove: Function,
    begin: Option<Function>,
    record: Option<Function>,
}

impl PageVolumes {
    pub fn new(obj: &Object) -> Result<Self, JsValue> {
        let what = "the volume store";
        Ok(Self {
            this: obj.into(),
            has: required(obj, "has", what)?,
            get: required(obj, "get", what)?,
            put: required(obj, "put", what)?,
            copy: required(obj, "copy", what)?,
            remove: required(obj, "remove", what)?,
            begin: method(obj, "begin")?,
            record: method(obj, "record")?,
        })
    }

    fn failed(item: &Item, e: JsValue) -> EngineError {
        EngineError::Config(format!(
            "the page could not keep {}: {}",
            item_key(item),
            js_message(&e)
        ))
    }

    /// The NIfTI file kept under `item`, decoded.
    fn nifti(&self, item: &Item) -> Result<Option<qsm_core::io::NiftiData>, EngineError> {
        let key = JsValue::from_str(&item_key(item));
        let value = self
            .get
            .call1(&self.this, &key)
            .map_err(|e| Self::failed(item, e))?;
        let Ok(file) = Reflect::get(&value, &JsValue::from_str("nifti")) else {
            return Ok(None);
        };
        let Some(bytes) = file.dyn_ref::<Uint8Array>() else {
            return Ok(None);
        };
        qsm_core::io::load_nifti(&bytes.to_vec())
            .map(Some)
            .map_err(|e| EngineError::InvalidInput(format!("{}: {e}", item_key(item))))
    }

    /// The grid of the input file kept under `item` (`None` if there is none), decoding it as a
    /// read does (and so keeping its decoded values beside the file when they are exact in
    /// float32).
    ///
    /// The grid is kept beside the file too (`geometry`, Geometry JSON), so a page that hands the
    /// same input object to later engines (a mask preview after each edit) has it read once.
    fn input_geometry(&self, item: &Item) -> Result<Option<Geometry>, EngineError> {
        let key = JsValue::from_str(&item_key(item));
        let value = self
            .get
            .call1(&self.this, &key)
            .map_err(|e| Self::failed(item, e))?;
        if value.is_undefined() || value.is_null() {
            return Ok(None);
        }
        let kept = Reflect::get(&value, &JsValue::from_str("geometry"))
            .ok()
            .and_then(|g| g.as_string())
            .and_then(|g| serde_json::from_str::<Geometry>(&g).ok());
        if let Some(geometry) = kept {
            return Ok(Some(geometry));
        }
        let Some(nifti) = self.nifti(item)? else {
            return Err(EngineError::Config(format!(
                "the page keeps {} as something that is not a NIfTI file",
                item_key(item)
            )));
        };
        keep_decoded(&value, &nifti.data);
        let geometry = Geometry {
            dims: nifti.dims,
            voxel_size: nifti.voxel_size,
            affine: nifti.affine,
        };
        if let Ok(json) = serde_json::to_string(&geometry) {
            let _ = Reflect::set(&value, &JsValue::from_str("geometry"), &json.into());
        }
        Ok(Some(geometry))
    }

    /// Keep `from`'s volume under `to` as well: `true` if there was one.
    fn copy_key(&self, from: &str, to: &str) -> Result<bool, JsValue> {
        self.copy
            .call2(&self.this, &JsValue::from_str(from), &JsValue::from_str(to))
            .map(|v| v.is_truthy())
    }

    /// Forget the volume under `key`: `true` if there was one.
    fn remove_key(&self, key: &str) -> bool {
        self.remove
            .call1(&self.this, &JsValue::from_str(key))
            .is_ok_and(|v| v.is_truthy())
    }

    /// Move the volume under `from` to `to`: `true` if there was one.
    fn move_key(&self, from: &str, to: &str) -> bool {
        matches!(self.copy_key(from, to), Ok(true)) && self.remove_key(from)
    }

    /// Keep `values` under `key` as float32.
    fn put_single(
        &self,
        item: &Item,
        values: impl Iterator<Item = f32>,
    ) -> Result<(), EngineError> {
        let single: Vec<f32> = values.collect();
        let array = Float32Array::from(single.as_slice());
        self.put
            .call2(&self.this, &JsValue::from_str(&item_key(item)), &array)
            .map(|_| ())
            .map_err(|e| Self::failed(item, e))
    }
}

/// Keep an input's decoded values beside its file (`decoded`), when every one is exact in float32,
/// so it is decoded once.
fn keep_decoded(value: &JsValue, data: &[f64]) {
    if data.iter().all(|&v| f64::from(v as f32) == v || v.is_nan()) {
        let single: Vec<f32> = data.iter().map(|&v| v as f32).collect();
        let _ = Reflect::set(
            value,
            &JsValue::from_str("decoded"),
            &Float32Array::from(single.as_slice()),
        );
    }
}

impl Volumes for PageVolumes {
    fn contains(&self, item: &Item) -> bool {
        self.has
            .call1(&self.this, &JsValue::from_str(&item_key(item)))
            .is_ok_and(|v| v.is_truthy())
    }

    fn get(&self, item: &Item) -> Result<Option<VolumeData>, EngineError> {
        let key = JsValue::from_str(&item_key(item));
        let value = self
            .get
            .call1(&self.this, &key)
            .map_err(|e| Self::failed(item, e))?;
        if value.is_undefined() || value.is_null() {
            return Ok(None);
        }
        // An input decoded on an earlier read.
        let decoded = Reflect::get(&value, &JsValue::from_str("decoded")).unwrap_or_default();
        if let Some(a) = value
            .dyn_ref::<Float32Array>()
            .or_else(|| decoded.dyn_ref::<Float32Array>())
        {
            let mut single = vec![0.0f32; a.length() as usize];
            a.copy_to(&mut single);
            return Ok(Some(VolumeData::Real(
                single.into_iter().map(f64::from).collect(),
            )));
        }
        if let Some(a) = value.dyn_ref::<Float64Array>() {
            return Ok(Some(VolumeData::Real(a.to_vec())));
        }
        if let Some(a) = value.dyn_ref::<Uint8Array>() {
            return Ok(Some(VolumeData::Mask(a.to_vec())));
        }
        let Some(nifti) = self.nifti(item)? else {
            return Err(EngineError::Config(format!(
                "the page keeps {} as something that is not a volume",
                item_key(item)
            )));
        };
        let data = nifti.data;
        keep_decoded(&value, &data);
        Ok(Some(VolumeData::Real(data)))
    }

    fn insert(&mut self, item: Item, volume: VolumeRef<'_>) -> Result<(), EngineError> {
        match volume {
            // As `qsmxt run` writes it: float32.
            VolumeRef::Real(v) => self.put_single(&item, v.iter().map(|&x| x as f32)),
            VolumeRef::Mask(m) => self
                .put
                .call2(
                    &self.this,
                    &JsValue::from_str(&item_key(&item)),
                    &Uint8Array::from(m),
                )
                .map(|_| ())
                .map_err(|e| Self::failed(&item, e)),
        }
    }

    fn copy(&mut self, from: &Item, to: Item) -> Result<bool, EngineError> {
        self.copy_key(&item_key(from), &item_key(&to))
            .map_err(|e| Self::failed(&to, e))
    }

    fn remove(&mut self, item: &Item) -> bool {
        self.remove_key(&item_key(item))
    }

    fn set_aside(&mut self, item: &Item) -> bool {
        self.move_key(&item_key(item), &aside_key(item))
    }

    fn put_back(&mut self, item: &Item) -> bool {
        self.move_key(&aside_key(item), &item_key(item))
    }

    fn drop_aside(&mut self, item: &Item) {
        self.remove_key(&aside_key(item));
    }

    fn begin(&mut self, meta: &RunMetadata) {
        if let (Some(begin), Ok(json)) = (&self.begin, serde_json::to_string(meta)) {
            let _ = begin.call1(&self.this, &JsValue::from_str(&json));
        }
    }

    fn recorded(&mut self, recorded: &Recorded) {
        if let (Some(record), Ok(json)) = (&self.record, serde_json::to_string(recorded)) {
            let _ = record.call1(&self.this, &JsValue::from_str(&json));
        }
    }
}

// ============================================================================
// Reporting to the page
// ============================================================================

/// An [`Observer`] that calls the page: a JS object with any of
///
/// - `stage(step, algorithm, event, text)`: `event` is `"started"` (`text` says what the step is
///   doing), `"cached"` (its earlier output is still valid) or `"finished"` (`text` names it);
/// - `progress(done, total)`: of the step being computed;
/// - `log(level, message, step)`: `level` is `"ERROR"`, `"WARN"`, `"INFO"`, `"DEBUG"` or
///   `"TRACE"`; `step` is the step being computed, or `null` between steps;
/// - `output(key)`: a step kept a volume, in the page's volumes under `key`.
///
/// Every line the engine and qsm-core log through the `log` crate during the run reaches `log`
/// too, tagged with its step, so the page sees the log `qsmxt run` prints.
struct Relay {
    this: JsValue,
    stage: Option<Function>,
    progress: Option<Function>,
    log: Option<Function>,
    output: Option<Function>,
}

impl Relay {
    fn new(obj: &Object) -> Result<Self, JsValue> {
        Ok(Self {
            this: obj.into(),
            stage: method(obj, "stage")?,
            progress: method(obj, "progress")?,
            log: method(obj, "log")?,
            output: method(obj, "output")?,
        })
    }
}

/// What the page is told, and nothing it does in return, decides the run: a callback that throws
/// is ignored.
impl Observer for Relay {
    fn stage(&mut self, step: &str, algorithm: Option<&str>, event: StageEvent<'_>) {
        CURRENT_STEP.with(|s| {
            *s.borrow_mut() = match event {
                StageEvent::Started(_) | StageEvent::Cached => Some(step.to_string()),
                StageEvent::Finished(_) => None,
            }
        });
        let Some(f) = &self.stage else { return };
        let (kind, text) = match event {
            StageEvent::Started(t) => ("started", Some(t)),
            StageEvent::Cached => ("cached", None),
            StageEvent::Finished(t) => ("finished", Some(t)),
        };
        let args = js_sys::Array::of4(
            &step.into(),
            &algorithm.map_or(JsValue::NULL, JsValue::from_str),
            &kind.into(),
            &text.map_or(JsValue::NULL, JsValue::from_str),
        );
        let _ = f.apply(&self.this, &args);
    }

    fn progress(&mut self, done: usize, total: usize) {
        if let Some(f) = &self.progress {
            let _ = f.call2(&self.this, &(done as f64).into(), &(total as f64).into());
        }
    }

    fn log(&mut self, level: log::Level, message: &str) {
        if let Some(f) = &self.log {
            let _ = f.call3(
                &self.this,
                &level.as_str().into(),
                &message.into(),
                &current_step(),
            );
        }
    }

    fn output(&mut self, item: &Item, _volume: VolumeRef<'_>) {
        if let Some(f) = &self.output {
            let _ = f.call1(&self.this, &JsValue::from_str(&item_key(item)));
        }
    }
}

thread_local! {
    /// Where `log` lines go while a run is under way: the page's `log(level, message, step)`.
    static LOG_SINK: RefCell<Option<(JsValue, Function)>> = const { RefCell::new(None) };
    /// The step being computed (from its `started` or `cached` event to its `finished` one), for
    /// the page's log lines and a failed run's error.
    static CURRENT_STEP: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// The step being computed, or `null`.
fn current_step() -> JsValue {
    CURRENT_STEP.with(|s| {
        s.borrow()
            .as_deref()
            .map_or(JsValue::NULL, JsValue::from_str)
    })
}

/// What a failed run throws: an `Error` with the engine's message, its `kind` (`"input"`: the
/// scan's files or facts; `"requirements"`: an output the data cannot produce; `"config"`,
/// `"dimension_mismatch"`, `"invalid_input"`: the engine's own kinds) and the `step` it failed in
/// (`null` before or between steps).
fn run_error(message: &str, kind: &str, step: JsValue) -> JsValue {
    let error = js_sys::Error::new(message);
    let _ = Reflect::set(&error, &"kind".into(), &kind.into());
    let _ = Reflect::set(&error, &"step".into(), &step);
    error.into()
}

fn engine_error(e: &EngineError) -> JsValue {
    let kind = match e {
        EngineError::Config(_) => "config",
        EngineError::DimensionMismatch(_) => "dimension_mismatch",
        EngineError::InvalidInput(_) => "invalid_input",
    };
    run_error(&e.to_string(), kind, current_step())
}

/// The errors among a scan's input problems, as one `"input"` error.
fn input_error(report: &ScanReport) -> JsValue {
    let messages: Vec<&str> = report
        .problems
        .iter()
        .filter(|p| p.severity == qsmxt_engine::requirements::Severity::Error)
        .map(|p| p.message.as_str())
        .collect();
    run_error(&messages.join("; "), "input", JsValue::NULL)
}

/// Forwards the `log` crate to the page during a run. Lines logged on other threads (a threaded
/// build's rayon workers) or outside a run are dropped.
struct PageLog;

impl log::Log for PageLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        LOG_SINK.with(|sink| {
            if let Some((this, f)) = sink.borrow().as_ref() {
                let message = record.args().to_string();
                let _ = f.call3(
                    this,
                    &record.level().as_str().into(),
                    &message.into(),
                    &current_step(),
                );
            }
        });
    }

    fn flush(&self) {}
}

static PAGE_LOG: PageLog = PageLog;

/// Run `f` with the `log` crate's lines going to the page's `log(level, message)` (`sink`: the
/// observer and its `log` method).
fn logging_to<T>(sink: Option<(JsValue, Function)>, f: impl FnOnce() -> T) -> T {
    if log::set_logger(&PAGE_LOG).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    LOG_SINK.with(|s| *s.borrow_mut() = sink);
    CURRENT_STEP.with(|s| *s.borrow_mut() = None);
    let out = f();
    LOG_SINK.with(|s| *s.borrow_mut() = None);
    out
}

// ============================================================================
// Mask previews
// ============================================================================

/// The images mask sections work from (`qsmxt_engine::stages::mask::MaskInputs`), kept between
/// [`Engine::preview_mask`] calls (and across engines over the same volumes): built once, then
/// reused while only thresholds and morphology change, and built again when what they were built
/// from changes. They are kept in double precision, as the run's mask step computes them, so a
/// preview is bit for bit the run's mask.
#[wasm_bindgen]
#[derive(Default)]
pub struct MaskPreviewInputs {
    inner: MaskInputs,
}

#[wasm_bindgen]
impl MaskPreviewInputs {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MaskPreviewInputs {
        MaskPreviewInputs::default()
    }

    /// Bytes held in the WASM heap.
    pub fn bytes(&self) -> f64 {
        self.inner.bytes() as f64
    }
}

/// Where a mask supplied for a run is written as a BIDS derivative of `tool`, so `qsmxt run
/// --use-custom-masks <tool>` uses it for that run: `derivatives/<tool>/sub-X/[ses-Y/]anat/<prefix>_mask.nii.gz`
/// (`qsmxt_engine::supplied::supplied_mask_path`), `prefix` being the run's BIDS prefix
/// (`sub-01_ses-pre_run-1`).
#[wasm_bindgen]
pub fn supplied_mask_path_wasm(tool: &str, prefix: &str) -> Result<String, JsValue> {
    qsmxt_engine::supplied::supplied_mask_path(tool, prefix).map_err(js_err)
}

// ============================================================================
// A scan, and runs of it
// ============================================================================

/// One scan, loaded, and the runs made of it: the step cache lives here, so running again with
/// changed settings recomputes only the steps whose keys changed and what follows them.
#[wasm_bindgen]
pub struct Engine {
    store: MemoryStore<PageVolumes>,
    facts: ScanFacts,
}

#[wasm_bindgen]
impl Engine {
    /// A scan whose volumes the page keeps in `volumes` ([`PageVolumes`]), each image as its NIfTI
    /// file under the item [`scan_report_wasm`]'s `files` names for it: echo `n`'s phase and
    /// magnitude under `AcquiredPhase(n)` and `AcquiredMagnitude(n)`, a real/imaginary scan's
    /// parts under `AcquiredReal(n)` and `AcquiredImaginary(n)`, uncombined coil `c`'s under
    /// `CoilPhase(c, n)` and `CoilMagnitude(c, n)`, and a MESE's echoes under `MeseMagnitude(n)`. `inputs_json` is the scan as [`scan_report_wasm`] takes
    /// it (`ScanInputs` JSON): its echoes, each with its sidecar, and the values the user typed in.
    /// The headers are read from the files here, as the run reads them; the geometry the JSON
    /// gives is not used. Files supplied for the run are read from the volumes too:
    /// `SuppliedMask`, `SuppliedChi`, `SuppliedR2`, `SuppliedR2prime` and
    /// `SuppliedSegmentation`, each as its NIfTI file. A scan whose inputs have errors is refused (an `"input"` error, naming
    /// them). `identity` is anything that changes when the inputs do (e.g. a load counter), so a
    /// new scan under the same engine recomputes everything. `recorded_json`, when given, is what
    /// an earlier engine over the same volumes recorded (the last `record` call): its completed
    /// steps stay cached.
    #[wasm_bindgen(constructor)]
    pub fn new(
        volumes: Object,
        inputs_json: &str,
        identity: &str,
        recorded_json: Option<String>,
    ) -> Result<Engine, JsValue> {
        let volumes = PageVolumes::new(&volumes)?;
        let mut inputs = parse_scan_inputs(inputs_json).map_err(js_err)?;
        // Every image's header as the run reads it, from the file the page keeps under its item.
        inputs
            .read_headers(|item| volumes.input_geometry(item))
            .map_err(js_err)?;
        let report = inputs.facts();
        let (Some(facts), Some(header), false) = (
            report.facts.clone(),
            inputs.header(&report),
            report.has_errors(),
        ) else {
            return Err(input_error(&report));
        };
        let mut facts = facts;
        // Files supplied for this run (a brain mask, χ, R2, R2′, a segmentation), as the run's
        // `--use-custom-*` settings read them: found when the page keeps them.
        // An unreadable mask is still a mask supplied: the run says so and computes one, as
        // `qsmxt run` does.
        let origin = || "the supplied file".to_string();
        let mask = match volumes.nifti(&Item::SuppliedMask) {
            Ok(None) => None,
            Ok(Some(m)) => Some(Supplied::Found {
                origin: origin(),
                data: m.data,
                dims: m.dims,
                affine: m.affine,
            }),
            Err(e) => Some(Supplied::Unreadable {
                origin: origin(),
                error: e.to_string(),
            }),
        };
        let mut supplied = Vec::new();
        for item in [
            Item::SuppliedChi,
            Item::SuppliedR2,
            Item::SuppliedR2prime,
            Item::SuppliedSegmentation,
        ] {
            if let Some(geometry) = volumes.input_geometry(&item).map_err(js_err)? {
                supplied.push((item, geometry));
            }
        }
        let found = |item: Item| supplied.iter().any(|(i, _)| *i == item);
        facts.custom_mask = mask.is_some();
        facts.custom_qsm = found(Item::SuppliedChi);
        facts.custom_r2 = found(Item::SuppliedR2);
        facts.custom_r2prime = found(Item::SuppliedR2prime);
        facts.custom_dseg = found(Item::SuppliedSegmentation);
        let mut store = MemoryStore::with_volumes(header, identity.into(), volumes);
        // A MESE for R2, and the grids of its echoes.
        inputs.supply(&report, &mut store);
        if let Some(mask) = mask {
            store.supply_mask(mask);
        }
        for (item, geometry) in supplied {
            store.set_geometry(item, geometry);
        }
        if let Some(json) = recorded_json {
            let recorded: Recorded = serde_json::from_str(&json)
                .map_err(|e| js_err(format!("the recorded steps are not valid: {e}")))?;
            store.restore(recorded);
        }
        Ok(Engine { store, facts })
    }

    /// The scan's facts (ScanFacts JSON).
    pub fn facts(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.facts).map_err(js_err)
    }

    /// What a run of `config_json` (PipelineConfig JSON) on this scan will do, on `threads`
    /// threads: [`plan_wasm`].
    pub fn plan(&self, config_json: &str, threads: Option<u32>) -> Result<String, JsValue> {
        plan_json(
            &parse_config(config_json)?,
            &self.facts,
            threads.map_or(DL_THREADS, |t| t as usize),
        )
        .map_err(js_err)
    }

    /// The pipeline a run of `config_json` on this scan will take, as a graph
    /// ([`crate::settings::pipeline_graph_wasm`]), drawn on the run's grid once a run has loaded
    /// the scan (so the return to the acquired grid is drawn only when the run is resampled).
    #[wasm_bindgen(js_name = pipelineGraph)]
    pub fn pipeline_graph(&self, config_json: &str) -> Result<String, JsValue> {
        crate::settings::graph_json(&parse_config(config_json)?, &self.facts, self.store.grid())
            .map_err(js_err)
    }

    /// Supply the brain mask (a NIfTI file) for runs whose config names a custom mask tool
    /// (`masking.custom_mask_tool`): the run uses it in place of computing one, as `qsmxt run
    /// --use-custom-masks` does. `origin` names it in the log.
    #[wasm_bindgen(js_name = supplyMask)]
    pub fn supply_mask(&mut self, nifti: &[u8], origin: &str) {
        let origin = origin.to_string();
        self.store
            .supply_mask(match qsm_core::io::load_nifti(nifti) {
                Ok(m) => Supplied::Found {
                    origin,
                    data: m.data,
                    dims: m.dims,
                    affine: m.affine,
                },
                Err(error) => Supplied::Unreadable { origin, error },
            });
        self.facts.custom_mask = true;
    }

    /// The mask a recipe makes on this scan, computed by the run's own masking
    /// (`qsmxt_engine::run::preview_mask`): `sections_json` (a JSON array of mask sections; the
    /// config's `masking.sections` when absent, or e.g. its two-pass sections), combined and
    /// refined as `config_json` says, up to `upto_json` (`"recipe"`, the whole recipe and the mask
    /// a run makes; or `{ "section": { "index": i, "ops": n } }`, section `i` after its first `n`
    /// steps). The steps the mask step reads from run first, cached as a run caches them, and
    /// report to `observer` as a run does; nothing else is written, so the brain mask and
    /// everything after it stay as they were. The images the sections work from are kept in
    /// `inputs` for the next preview.
    ///
    /// Returns `{ mask: Uint8Array, image: Float32Array, input, otsu, voxels }`: the mask, the
    /// image of the section shown (the first one for the whole recipe) and its input
    /// (`phase-quality`, `magnitude`, ...), Otsu's threshold of that image, and the voxels in the
    /// mask.
    #[wasm_bindgen(js_name = previewMask)]
    pub fn preview_mask(
        &mut self,
        config_json: &str,
        sections_json: Option<String>,
        upto_json: &str,
        inputs: &mut MaskPreviewInputs,
        observer: Object,
    ) -> Result<Object, JsValue> {
        let config = parse_config(config_json)?;
        let sections: Vec<MaskSection> = match sections_json {
            Some(json) => serde_json::from_str(&json)
                .map_err(|e| js_err(format!("the mask sections are not valid: {e}")))?,
            None => config.masking.sections.clone(),
        };
        let upto: Upto = serde_json::from_str(upto_json)
            .map_err(|e| js_err(format!("what to preview is not valid: {e}")))?;
        let mut relay = Relay::new(&observer)?;
        let sink = relay.log.clone().map(|log| (relay.this.clone(), log));
        let plan = qsmxt_engine::plan::plan(&config, &self.facts);
        let (store, facts) = (&mut self.store, &self.facts);
        let preview = logging_to(sink, || {
            qsmxt_engine::run::preview_mask(
                &plan,
                &config,
                facts,
                store,
                &mut relay,
                &mut inputs.inner,
                &sections,
                upto,
            )
            .map_err(|e| engine_error(&e))
        })?;
        let out = Object::new();
        let single: Vec<f32> = preview.image.iter().map(|&v| v as f32).collect();
        Reflect::set(
            &out,
            &"mask".into(),
            &Uint8Array::from(preview.mask.as_slice()),
        )?;
        Reflect::set(
            &out,
            &"image".into(),
            &Float32Array::from(single.as_slice()),
        )?;
        Reflect::set(&out, &"input".into(), &preview.input.to_string().into())?;
        Reflect::set(&out, &"otsu".into(), &preview.otsu.into())?;
        Reflect::set(&out, &"voxels".into(), &(preview.voxels as f64).into())?;
        Ok(out)
    }

    /// Run `config_json` (PipelineConfig JSON) on this scan, reporting to `observer` ([`Relay`]).
    /// What the scan's data cannot produce of what was asked for fails the run before anything is
    /// computed, in `qsmxt run`'s words. The weights of the plan's models must have been provided.
    /// A failed run throws an `Error` with the step it failed in and the kind of failure
    /// ([`run_error`]). Returns what the run did (RunRecord JSON: each step `computed`, `cached` or
    /// `skipped`, and what it decided), for `pipeline_graph_after_wasm` and `methods_for_run_wasm`.
    pub fn run(&mut self, config_json: &str, observer: Object) -> Result<String, JsValue> {
        let config = parse_config(config_json)?;
        let mut relay = Relay::new(&observer)?;
        let sink = relay.log.clone().map(|log| (relay.this.clone(), log));
        let plan = qsmxt_engine::plan::plan(&config, &self.facts);
        let (store, facts) = (&mut self.store, &self.facts);
        logging_to(sink, || {
            if let Err(e) = plan.check.clone().finish() {
                return Err(run_error(&e.to_string(), "requirements", JsValue::NULL));
            }
            for note in &plan.notes {
                log::info!("{note}");
            }
            qsmxt_engine::run::run(&plan, &config, facts, store, &mut relay)
                .map_err(|e| engine_error(&e))
        })
        .and_then(|record| serde_json::to_string(&record).map_err(js_err))
    }

    /// The grid the last run worked on (RunMetadata JSON), once it has loaded the scan.
    pub fn grid(&self) -> Option<String> {
        self.store
            .grid()
            .and_then(|m| serde_json::to_string(m).ok())
    }

    /// The grid of the volume kept under `key` ([`item_key`]) when it is not the run's (Geometry
    /// JSON: `dims`, `voxel_size`, `affine`): a minimum-intensity projection's, or an output's
    /// once a resampled run has returned it to the acquired grid. `undefined` for a volume on the
    /// run's grid. Outputs on a grid of their own are not passed to the observer's `output`.
    pub fn geometry(&self, key: &str) -> Option<String> {
        let item = Item::from_key(key)?;
        self.store
            .geometry(&item)
            .and_then(|g| serde_json::to_string(g).ok())
    }
}

/// The volumes the page holds, by key, and nothing of their data: all a dry run looks at
/// ([`plan_state`]).
struct Held(std::collections::HashSet<String>);

impl Volumes for Held {
    fn contains(&self, item: &Item) -> bool {
        self.0.contains(&item_key(item))
    }

    fn get(&self, _item: &Item) -> Result<Option<VolumeData>, EngineError> {
        Ok(None)
    }

    fn insert(&mut self, item: Item, _volume: VolumeRef<'_>) -> Result<(), EngineError> {
        self.0.insert(item_key(&item));
        Ok(())
    }

    fn remove(&mut self, item: &Item) -> bool {
        self.0.remove(&item_key(item))
    }

    fn set_aside(&mut self, item: &Item) -> bool {
        self.remove(item)
    }

    fn put_back(&mut self, item: &Item) -> bool {
        self.0.insert(item_key(item));
        true
    }

    fn drop_aside(&mut self, _item: &Item) {}
}

/// What a run of `config` would do with each step, given what the page holds: the engine's
/// `run::dry_run` over the page's record (`recorded_json`, what the last [`Engine`] recorded) and
/// the keys of the volumes it holds (`held_json`), on the scan `inputs_json` describes, whose
/// identity is `identity` (as given to [`Engine::new`]). JSON: `[{ id, state, key? }]` in the
/// plan's order, `state` one of `cached`, `will_run`, `changed`, `stale`, `skipped`.
pub fn plan_state(
    config_json: &str,
    facts_json: &str,
    inputs_json: &str,
    identity: &str,
    recorded_json: Option<&str>,
    held_json: &str,
) -> Result<String, String> {
    let config = crate::settings::parse_config(config_json)?;
    let facts = crate::settings::parse_facts(facts_json)?;
    let inputs = parse_scan_inputs(inputs_json)?;
    let held: std::collections::HashSet<String> = serde_json::from_str(held_json)
        .map_err(|e| format!("the held volumes are not a JSON list of keys: {e}"))?;
    let first = inputs
        .echoes
        .first()
        .and_then(|e| e.phase.clone())
        .ok_or("the scan has no first phase image")?;
    let header = Header {
        dims: first.dims,
        voxel_size: first.voxel_size,
        affine: first.affine,
        sidecar: inputs.facts().sidecars.into_iter().next(),
    };
    let mut store = MemoryStore::with_volumes(header, identity.into(), Held(held));
    if let Some(json) = recorded_json {
        let recorded: Recorded = serde_json::from_str(json)
            .map_err(|e| format!("the recorded steps are not valid: {e}"))?;
        store.restore(recorded);
    }
    let plan = qsmxt_engine::plan::plan(&config, &facts);
    let expected =
        qsmxt_engine::run::dry_run(&plan, &config, &facts, &store).map_err(|e| e.to_string())?;
    serde_json::to_string(&expected).map_err(|e| e.to_string())
}

/// [`plan_state`], for the page.
#[wasm_bindgen]
pub fn plan_state_wasm(
    config_json: &str,
    facts_json: &str,
    inputs_json: &str,
    identity: &str,
    recorded_json: Option<String>,
    held_json: &str,
) -> Result<String, JsValue> {
    plan_state(
        config_json,
        facts_json,
        inputs_json,
        identity,
        recorded_json.as_deref(),
        held_json,
    )
    .map_err(js_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sphere of tissue in a 16³ box at 1 mm, three echoes, as the page describes it
    /// (`ScanInputs`), and a store holding it under `identity`.
    fn phantom(identity: &str) -> (String, ScanFacts, MemoryStore) {
        const N: usize = 16;
        let tes = [0.005, 0.010, 0.015];
        let mut affine = [0.0; 16];
        for i in 0..4 {
            affine[5 * i] = 1.0;
        }
        let grid = serde_json::json!({ "dims": [N, N, N], "voxel_size": [1.0, 1.0, 1.0], "affine": affine });
        let inputs = serde_json::json!({
            "echoes": tes.iter().map(|te| serde_json::json!({
                "phase": grid, "magnitude": grid,
                "sidecar": { "EchoTime": te, "MagneticFieldStrength": 3.0 },
            })).collect::<Vec<_>>(),
            "overrides": {},
        });
        let report = parse_scan_inputs(&inputs.to_string()).unwrap().facts();
        let facts = report.facts.clone().expect("facts");
        let header = Header {
            dims: (N, N, N),
            voxel_size: (1.0, 1.0, 1.0),
            affine,
            sidecar: report.sidecars.into_iter().next(),
        };
        let mut store = MemoryStore::new(header, identity.into());
        let c = (N as f64 - 1.0) / 2.0;
        let mut field = vec![0.0; N * N * N];
        let mut magnitude = vec![1.0; N * N * N];
        for z in 0..N {
            for y in 0..N {
                for x in 0..N {
                    let (dx, dy, dz) = (x as f64 - c, y as f64 - c, z as f64 - c);
                    if dx * dx + dy * dy + dz * dz < 36.0 {
                        let i = x + y * N + z * N * N;
                        field[i] = 4.0 * dx / 6.0 + 2.0 * (dz / 6.0).powi(2);
                        magnitude[i] = 100.0;
                    }
                }
            }
        }
        let pi = std::f64::consts::PI;
        for (e, te) in tes.iter().enumerate() {
            let phase = field
                .iter()
                .map(|f| (2.0 * pi * f * te + pi).rem_euclid(2.0 * pi) - pi)
                .collect();
            store.insert(Item::AcquiredPhase(e + 1), VolumeData::Real(phase));
            store.insert(
                Item::AcquiredMagnitude(e + 1),
                VolumeData::Real(magnitude.clone()),
            );
        }
        (inputs.to_string(), facts, store)
    }

    /// A configuration quick enough for the phantom: a magnitude threshold, PDF and TKD.
    fn quick_config() -> PipelineConfig {
        use qsmxt_engine::masking::{MaskOp, MaskSection, MaskThresholdMethod, MaskingInput};
        let mut config = PipelineConfig::default();
        config.masking.sections = vec![MaskSection {
            input: MaskingInput::Magnitude,
            generator: MaskOp::Threshold {
                method: MaskThresholdMethod::Otsu,
                value: None,
            },
            refinements: vec![],
        }];
        config.masking.refinements = vec![];
        config.masking.inhomogeneity_correction = false;
        config.bg_removal.algorithm = qsmxt_engine::BfAlgorithm::Pdf;
        config.inversion.algorithm = qsmxt_engine::QsmAlgorithm::Tkd;
        config
    }

    /// Each step's state, by name.
    fn states(json: &str) -> Vec<(String, String)> {
        let v: Vec<serde_json::Value> = serde_json::from_str(json).unwrap();
        v.iter()
            .map(|e| {
                (
                    e["id"].as_str().unwrap().to_string(),
                    e["state"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    /// The page's plan state is the engine's dry run over what it holds: every step will run
    /// before a run; after one, everything is cached; a new TKD threshold changes the inversion
    /// and makes referencing stale; new input data changes the load step. The keys the page
    /// holds count: a step whose output is gone is computed again.
    #[test]
    fn plan_state_is_the_engines_dry_run_over_what_the_page_holds() {
        let (inputs, facts, mut store) = phantom("inputs-1");
        let mut config = quick_config();
        let facts_json = serde_json::to_string(&facts).unwrap();
        let state =
            |config: &PipelineConfig, identity: &str, recorded: Option<&str>, held: &[String]| {
                let json = plan_state(
                    &config.to_json().unwrap(),
                    &facts_json,
                    &inputs,
                    identity,
                    recorded,
                    &serde_json::to_string(held).unwrap(),
                )
                .unwrap();
                states(&json)
            };
        let inputs_held: Vec<String> = (1..=3)
            .flat_map(|e| [Item::AcquiredPhase(e), Item::AcquiredMagnitude(e)])
            .map(|i| item_key(&i))
            .collect();
        let before = state(&config, "inputs-1", None, &inputs_held);
        assert!(
            before
                .iter()
                .all(|(_, s)| s == "will_run" || s == "skipped"),
            "{before:?}"
        );

        let plan = qsmxt_engine::plan::plan(&config, &facts);
        qsmxt_engine::run::run(&plan, &config, &facts, &mut store, &mut ()).unwrap();
        let recorded = store.recorded();
        let mut held = inputs_held.clone();
        held.extend(
            recorded
                .steps
                .values()
                .flat_map(|(_, outputs)| outputs.iter().cloned()),
        );
        let recorded = serde_json::to_string(&recorded).unwrap();

        let after = state(&config, "inputs-1", Some(&recorded), &held);
        assert!(
            after.iter().all(|(_, s)| s == "cached" || s == "skipped"),
            "{after:?}"
        );

        config.inversion.tkd.threshold *= 2.0;
        let changed = state(&config, "inputs-1", Some(&recorded), &held);
        let of = |list: &[(String, String)], id: &str| {
            list.iter().find(|(i, _)| i == id).map(|(_, s)| s.clone())
        };
        assert_eq!(of(&changed, "bgremove").as_deref(), Some("cached"));
        assert_eq!(of(&changed, "invert").as_deref(), Some("changed"));
        assert_eq!(of(&changed, "reference").as_deref(), Some("stale"));

        let without_chi: Vec<String> = held.iter().filter(|k| *k != "Chi").cloned().collect();
        let gone = state(&quick_config(), "inputs-1", Some(&recorded), &without_chi);
        assert_eq!(of(&gone, "reference").as_deref(), Some("stale"), "{gone:?}");
        assert_eq!(of(&gone, "invert").as_deref(), Some("cached"));

        let new_data = state(&quick_config(), "inputs-2", Some(&recorded), &held);
        assert_eq!(of(&new_data, "load").as_deref(), Some("changed"));
        assert_eq!(of(&new_data, "invert").as_deref(), Some("stale"));
    }

    /// The page's scan report is the engine's `ScanInputs::facts`, as JSON.
    #[test]
    fn scan_report_is_the_engines() {
        let affine = [
            1.0, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ];
        let grid =
            serde_json::json!({ "dims": [4, 4, 4], "voxel_size": [1, 1, 1], "affine": affine });
        let inputs = serde_json::json!({
            "echoes": [
                { "phase": grid, "magnitude": grid, "sidecar": { "EchoTime": 0.004, "MagneticFieldStrength": 3.0 } },
                { "phase": grid, "magnitude": null, "sidecar": { "EchoTime": 0.008 } },
            ],
            "overrides": {},
        });
        let report: serde_json::Value =
            serde_json::from_str(&scan_report(&inputs.to_string()).unwrap()).unwrap();
        let expected = serde_json::to_value(
            serde_json::from_value::<ScanInputs>(inputs)
                .unwrap()
                .facts(),
        )
        .unwrap();
        assert_eq!(report, expected);
        // Magnitude for one echo of two is an error on echo 2's magnitude.
        assert_eq!(report["problems"][0]["echo"], 2);
        assert_eq!(report["problems"][0]["part"], "magnitude");
        assert!(scan_report("[]").is_err());
    }
}
