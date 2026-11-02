//! What QSMxT says about a configuration, for the page: its settings schema, the browser profile,
//! which settings apply to a configuration and what is wrong with them, single settings read and
//! written through the config's own serde, the `qsmxt run` command, the configuration as TOML (and
//! back), the pipeline graph, and what each of the engine's items is.
//!
//! Every answer is `qsmxt-engine`'s own: these functions parse their arguments, call the engine
//! and serialise its answer, and decide nothing themselves. Arguments and answers are JSON (or
//! TOML) text, as for [`crate::engine::plan_wasm`]. A configuration is `PipelineConfig` JSON and
//! the scan's facts are `ScanFacts` JSON; `null` facts mean "not known", which counts every
//! setting the data could need.
//!
//! Each export is a thin wrapper around a function of the same name without the `_wasm` suffix,
//! which returns its error as a `String` so it can be tested off wasm.

use qsmxt_engine::pipeline_graph::{pipeline_graph, pipeline_graph_after, pipeline_graph_on};
use qsmxt_engine::recommendations::{self as rec, Facts};
use qsmxt_engine::record::RunRecord;
use qsmxt_engine::scan::{RunMetadata, ScanFacts};
use qsmxt_engine::schema::{self, ViewFacts};
use qsmxt_engine::store::Item;
use qsmxt_engine::PipelineConfig;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::js_err;

pub(crate) fn parse_config(config_json: &str) -> Result<PipelineConfig, String> {
    serde_json::from_str(config_json)
        .map_err(|e| format!("config JSON is not a valid PipelineConfig: {e}"))
}

pub(crate) fn parse_facts(facts_json: &str) -> Result<ScanFacts, String> {
    serde_json::from_str(facts_json).map_err(|e| format!("facts JSON is not valid ScanFacts: {e}"))
}

fn to_json(config: &PipelineConfig) -> Result<String, String> {
    config.to_json().map_err(|e| e.to_string())
}

/// What `settings_view` needs to know about the scan: its echo count, whether its coils are
/// uncombined and whether it has magnitude images (motion correction needs them); with `scan` (the facts are a loaded scan's, not the example's the page plans with
/// before one is loaded), also its field strength, matrix size and, once read, voxel size, which
/// the pipeline rules that depend on the scan need. Without facts, nothing is known.
///
/// QSMxT has no conversion from `ScanFacts` to `ViewFacts` (its TUI fills `ViewFacts` from its
/// form), so it is written here; QSMxT/QSMxT#377 asks for it in the engine.
fn view_facts(facts_json: Option<&str>, scan: bool) -> Result<ViewFacts, String> {
    let Some(json) = facts_json.filter(|j| !j.trim().is_empty() && j.trim() != "null") else {
        return Ok(ViewFacts::default());
    };
    let facts = parse_facts(json)?;
    let (x, y, z) = facts.dims;
    Ok(ViewFacts {
        num_echoes: Some(facts.n_echoes),
        multi_coil: Some(facts.n_coils > 1),
        has_magnitude: Some(facts.has_magnitude),
        field_strength: scan.then_some(facts.field_strength),
        voxel_size: facts.voxel_size.filter(|_| scan).map(|(a, b, c)| [a, b, c]),
        dims: scan.then_some([x, y, z]),
    })
}

/// [`view_facts`], as the pipeline rules take them.
fn rule_facts(facts_json: Option<&str>, scan: bool) -> Result<Facts, String> {
    Ok(Facts::of_view(&view_facts(facts_json, scan)?))
}

/// An item's key ([`Item::key`]) and what it is ([`Item::meta`]).
pub(crate) fn item_info(item: &Item) -> Value {
    let mut info = serde_json::to_value(item.meta()).unwrap_or_else(|_| json!({}));
    info["key"] = item.key().into();
    info["item"] = serde_json::to_value(item).unwrap_or_default();
    info
}

// ============================================================================
// The schema and the browser profile
// ============================================================================

/// Every user-facing setting, with its wording, type, range, defaults and where it is shown, and
/// the mask recipe's parts (`mask`): `qsmxt_engine::schema::schema_json()`.
#[wasm_bindgen]
pub fn schema_json_wasm() -> String {
    schema::schema_json()
}

/// QSMxT's defaults with the browser profile applied (`PipelineConfig::browser()`): what a
/// browser run starts from.
pub fn browser_config() -> Result<String, String> {
    to_json(&PipelineConfig::browser())
}

/// [`browser_config`], as PipelineConfig JSON.
#[wasm_bindgen]
pub fn browser_config_wasm() -> Result<String, JsValue> {
    browser_config().map_err(js_err)
}

/// `config` with each default the browser cannot run replaced by the browser profile's value,
/// and every value the user set left alone (`PipelineConfig::apply_browser_profile`).
pub fn apply_browser_profile(config_json: &str) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    config.apply_browser_profile();
    to_json(&config)
}

/// [`apply_browser_profile`].
#[wasm_bindgen]
pub fn apply_browser_profile_wasm(config_json: &str) -> Result<String, JsValue> {
    apply_browser_profile(config_json).map_err(js_err)
}

/// The mask recipe's presets and step defaults as a browser run takes them: each preset's recipe
/// and each step type's default (`schema.mask`) given the browser profile
/// (`apply_browser_profile`, which runs an HD-BET step on the whole volume as the low-memory
/// sliding window instead). `{ presets: { <preset>: { sections, combine, refinements } },
/// steps: { <kind>: <op> }, two_pass_sections }`, `two_pass_sections` being the reliable mask a
/// run uses while `masking.two_pass_sections` is unset (`default_two_pass_sections`). A mask builder writes these, so choosing a preset or adding a step
/// never brings back a default the browser cannot run.
pub fn browser_mask_defaults() -> Result<String, String> {
    let mask = schema::mask_schema();
    let mut presets = serde_json::Map::new();
    for p in &mask.presets {
        let mut c = PipelineConfig::browser();
        c.masking.sections = p.sections.clone();
        c.masking.combine = p.combine;
        c.masking.refinements = p.refinements.clone();
        c.apply_browser_profile();
        let m = &c.masking;
        presets.insert(
            p.value.to_string(),
            json!({ "sections": m.sections, "combine": m.combine, "refinements": m.refinements }),
        );
    }
    let mut steps = serde_json::Map::new();
    for step in &mask.steps {
        let op: qsmxt_engine::MaskOp =
            serde_json::from_value(step.default.clone()).map_err(|e| e.to_string())?;
        let mut c = PipelineConfig::browser();
        c.masking.refinements = vec![op];
        c.apply_browser_profile();
        steps.insert(step.kind.to_string(), json!(c.masking.refinements[0]));
    }
    let mut c = PipelineConfig::browser();
    c.masking.two_pass_sections = Some(qsmxt_engine::default_two_pass_sections());
    c.apply_browser_profile();
    let two_pass = c.masking.resolved_two_pass_sections();
    Ok(json!({ "presets": presets, "steps": steps, "two_pass_sections": two_pass }).to_string())
}

/// [`browser_mask_defaults`].
#[wasm_bindgen]
pub fn browser_mask_defaults_wasm() -> Result<String, JsValue> {
    browser_mask_defaults().map_err(js_err)
}

// ============================================================================
// Which settings apply, and single settings
// ============================================================================

/// How each setting applies to `config` on the scan `facts` describes, in schema order:
/// `[{ path, visible, forced_by, error, warning, reference, recommendations }]`
/// (`schema::settings_view`). `error` says what is wrong with a setting that applies: out of its
/// range, not a finite number, or refused by its own rule. `reference` is every pipeline rule of
/// the chosen methods that covers the setting, and `recommendations` the ones it departs from
/// (`recommendations::Recommendation`). `scan`: the facts are a loaded scan's (see
/// [`view_facts`]).
pub fn settings_view(
    config_json: &str,
    facts_json: Option<&str>,
    scan: bool,
) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let view = schema::settings_view(&config, &view_facts(facts_json, scan)?);
    serde_json::to_string(&view).map_err(|e| e.to_string())
}

/// [`settings_view`]; `facts_json` may be `null` (not known).
#[wasm_bindgen]
pub fn settings_view_wasm(
    config_json: &str,
    facts_json: Option<String>,
    scan: bool,
) -> Result<String, JsValue> {
    settings_view(config_json, facts_json.as_deref(), scan).map_err(js_err)
}

// ============================================================================
// The pipeline rules' findings
// ============================================================================

/// `config` with the finding of `rule` resolved (`recommendations::apply`): its setting set to the
/// rule's recommended value, or with `pick_json` to another value the rule allows, and marked the
/// user's choice; any dismissal of the rule dropped.
pub fn apply_recommendation(
    config_json: &str,
    rule: &str,
    pick_json: Option<&str>,
) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    let pick: Option<Value> = pick_json
        .map(|p| serde_json::from_str(p).map_err(|e| format!("{rule}: not a JSON value: {e}")))
        .transpose()?;
    rec::apply(&mut config, rule, pick.as_ref())?;
    to_json(&config)
}

/// [`apply_recommendation`].
#[wasm_bindgen]
pub fn apply_recommendation_wasm(
    config_json: &str,
    rule: &str,
    pick_json: Option<String>,
) -> Result<String, JsValue> {
    apply_recommendation(config_json, rule, pick_json.as_deref()).map_err(js_err)
}

/// `config` with the finding of `rule` dismissed for its setting's current value
/// (`recommendations::dismiss`, kept in `dismissed_recommendations`): refused for a rule with no
/// finding, or a required one.
pub fn dismiss_recommendation(
    config_json: &str,
    rule: &str,
    facts_json: Option<&str>,
    scan: bool,
) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    rec::dismiss(&mut config, rule, &rule_facts(facts_json, scan)?)?;
    to_json(&config)
}

/// [`dismiss_recommendation`].
#[wasm_bindgen]
pub fn dismiss_recommendation_wasm(
    config_json: &str,
    rule: &str,
    facts_json: Option<String>,
    scan: bool,
) -> Result<String, JsValue> {
    dismiss_recommendation(config_json, rule, facts_json.as_deref(), scan).map_err(js_err)
}

/// `config` with its dismissal of `rule` taken back (`recommendations::undismiss`).
pub fn undismiss_recommendation(config_json: &str, rule: &str) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    rec::undismiss(&mut config, rule);
    to_json(&config)
}

/// [`undismiss_recommendation`].
#[wasm_bindgen]
pub fn undismiss_recommendation_wasm(config_json: &str, rule: &str) -> Result<String, JsValue> {
    undismiss_recommendation(config_json, rule).map_err(js_err)
}

/// `config` less the dismissals that no longer match a finding (`recommendations::prune_dismissals`:
/// the setting changed, or the rule no longer applies), so going back to a value brings its
/// finding back.
pub fn prune_dismissals(
    config_json: &str,
    facts_json: Option<&str>,
    scan: bool,
) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    rec::prune_dismissals(&mut config, &rule_facts(facts_json, scan)?);
    to_json(&config)
}

/// [`prune_dismissals`].
#[wasm_bindgen]
pub fn prune_dismissals_wasm(
    config_json: &str,
    facts_json: Option<String>,
    scan: bool,
) -> Result<String, JsValue> {
    prune_dismissals(config_json, facts_json.as_deref(), scan).map_err(js_err)
}

fn parse_findings(findings_json: &str) -> Result<Vec<rec::Recommendation>, String> {
    serde_json::from_str(findings_json).map_err(|e| format!("not a list of findings: {e}"))
}

fn parse_methods(methods_json: &str) -> Result<Vec<rec::Trigger>, String> {
    serde_json::from_str(methods_json).map_err(|e| format!("not a list of methods: {e}"))
}

/// The choices in `config` that have a reference pipeline (`recommendations::chosen_methods`):
/// `[{ setting, value, name }]`. Compared before and after a change, a choice that appears is a
/// method just chosen.
pub fn chosen_methods(
    config_json: &str,
    facts_json: Option<&str>,
    scan: bool,
) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let methods = rec::chosen_methods(&config, &rule_facts(facts_json, scan)?);
    serde_json::to_string(&methods).map_err(|e| e.to_string())
}

/// [`chosen_methods`].
#[wasm_bindgen]
pub fn chosen_methods_wasm(
    config_json: &str,
    facts_json: Option<String>,
    scan: bool,
) -> Result<String, JsValue> {
    chosen_methods(config_json, facts_json.as_deref(), scan).map_err(js_err)
}

/// What to offer for the methods just chosen (`methods_json`, as [`chosen_methods`] gives them):
/// for each, `{ method, title, differences }`: its title (`recommendations::reference_title`) and
/// where `config` differs from its reference pipeline and has not kept its own value
/// (`recommendations::reference_differences`).
pub fn reference_offers(
    config_json: &str,
    facts_json: Option<&str>,
    scan: bool,
    methods_json: &str,
) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let facts = rule_facts(facts_json, scan)?;
    let offers: Vec<Value> = parse_methods(methods_json)?
        .iter()
        .map(|m| {
            json!({
                "method": m,
                "title": rec::reference_title(m),
                "differences": rec::reference_differences(&config, &facts, m),
            })
        })
        .collect();
    serde_json::to_string(&offers).map_err(|e| e.to_string())
}

/// [`reference_offers`].
#[wasm_bindgen]
pub fn reference_offers_wasm(
    config_json: &str,
    facts_json: Option<String>,
    scan: bool,
    methods_json: &str,
) -> Result<String, JsValue> {
    reference_offers(config_json, facts_json.as_deref(), scan, methods_json).map_err(js_err)
}

/// `recommendations::reference_title` of each of `methods_json`: "MEDI's reference pipeline".
pub fn reference_titles(methods_json: &str) -> Result<String, String> {
    let titles: Vec<String> = parse_methods(methods_json)?
        .iter()
        .map(rec::reference_title)
        .collect();
    serde_json::to_string(&titles).map_err(|e| e.to_string())
}

/// [`reference_titles`].
#[wasm_bindgen]
pub fn reference_titles_wasm(methods_json: &str) -> Result<String, JsValue> {
    reference_titles(methods_json).map_err(js_err)
}

/// "Keep mine": `config` with each finding kept at its setting's current value
/// (`recommendations::keep`, as dismissals); a required one is left.
pub fn keep_findings(config_json: &str, findings_json: &str) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    rec::keep(
        &mut config.dismissed_recommendations,
        &parse_findings(findings_json)?,
    );
    to_json(&config)
}

/// [`keep_findings`].
#[wasm_bindgen]
pub fn keep_findings_wasm(config_json: &str, findings_json: &str) -> Result<String, JsValue> {
    keep_findings(config_json, findings_json).map_err(js_err)
}

/// "Apply all": `config` with each finding's recommended value applied
/// (`recommendations::apply_all`); refused, with each reason, if any could not be.
pub fn apply_all(config_json: &str, findings_json: &str) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    rec::apply_all(&mut config, &parse_findings(findings_json)?)?;
    to_json(&config)
}

/// [`apply_all`].
#[wasm_bindgen]
pub fn apply_all_wasm(config_json: &str, findings_json: &str) -> Result<String, JsValue> {
    apply_all(config_json, findings_json).map_err(js_err)
}

/// `config` with every setting that does not apply to it put back to QSMxT's default
/// (`schema::prune_hidden`).
pub fn prune_hidden(config_json: &str, facts_json: Option<&str>) -> Result<String, String> {
    let config = parse_config(config_json)?;
    to_json(&schema::prune_hidden(
        &config,
        &view_facts(facts_json, false)?,
    ))
}

/// [`prune_hidden`]; `facts_json` may be `null` (not known).
#[wasm_bindgen]
pub fn prune_hidden_wasm(config_json: &str, facts_json: Option<String>) -> Result<String, JsValue> {
    prune_hidden(config_json, facts_json.as_deref()).map_err(js_err)
}

/// The value at `path` in `config`, as JSON (`schema::get`); `None` if there is no such setting.
pub fn get_setting(config_json: &str, path: &str) -> Result<Option<String>, String> {
    let config = parse_config(config_json)?;
    Ok(schema::get(&config, path).map(|v| v.to_string()))
}

/// [`get_setting`]: the value as JSON, or `undefined`.
#[wasm_bindgen]
pub fn get_setting_wasm(config_json: &str, path: &str) -> Result<Option<String>, JsValue> {
    get_setting(config_json, path).map_err(js_err)
}

/// `config` with `path` set to `value_json` (`schema::set`): the value goes through the config's
/// own deserialisation, so anything a config file would reject is refused, with the engine's
/// reason.
pub fn set_setting(config_json: &str, path: &str, value_json: &str) -> Result<String, String> {
    let mut config = parse_config(config_json)?;
    let value: Value =
        serde_json::from_str(value_json).map_err(|e| format!("{path}: not a JSON value: {e}"))?;
    schema::set(&mut config, path, value)?;
    to_json(&config)
}

/// [`set_setting`]: the changed config (PipelineConfig JSON); throws the engine's reason.
#[wasm_bindgen]
pub fn set_setting_wasm(
    config_json: &str,
    path: &str,
    value_json: &str,
) -> Result<String, JsValue> {
    set_setting(config_json, path, value_json).map_err(js_err)
}

// ============================================================================
// The command and the configuration file
// ============================================================================

/// The `qsmxt run` command that reproduces `config` (`generate_command`; settings that do not
/// apply are left out).
pub fn command(config_json: &str) -> Result<String, String> {
    Ok(qsmxt_engine::generate_command(&parse_config(config_json)?))
}

/// [`command`].
#[wasm_bindgen]
pub fn command_wasm(config_json: &str) -> Result<String, JsValue> {
    command(config_json).map_err(js_err)
}

/// `config` as a QSMxT configuration file: with `selected`, only the chosen background-removal
/// and inversion algorithms' tables (`PipelineConfig::to_toml_selected`); without, every setting,
/// as `qsmxt run` writes `pipeline_config.toml` (`to_toml`).
pub fn config_to_toml(config_json: &str, selected: bool) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let toml = if selected {
        config.to_toml_selected()
    } else {
        config.to_toml()
    };
    toml.map_err(|e| e.to_string())
}

/// [`config_to_toml`].
#[wasm_bindgen]
pub fn config_to_toml_wasm(config_json: &str, selected: bool) -> Result<String, JsValue> {
    config_to_toml(config_json, selected).map_err(js_err)
}

/// `config` as a QSMxT configuration file of only the settings that differ from QSMxT's defaults
/// (`PipelineConfig::to_toml_changed`; settings that do not apply are left out, as from the
/// command), so `qsmxt run --config` reproduces it.
pub fn config_to_toml_changed(config_json: &str) -> Result<String, String> {
    parse_config(config_json)?
        .to_toml_changed()
        .map_err(|e| e.to_string())
}

/// [`config_to_toml_changed`].
#[wasm_bindgen]
pub fn config_to_toml_changed_wasm(config_json: &str) -> Result<String, JsValue> {
    config_to_toml_changed(config_json).map_err(js_err)
}

/// A QSMxT configuration file, read as `qsmxt run --config` reads it
/// (`PipelineConfig::from_toml_migrating`), then given the browser profile
/// (`apply_browser_profile`: a default the browser cannot run becomes the browser's value; every
/// value the file sets is kept): `{ config, warnings }`, `warnings` being the engine's notes on
/// settings older QSMxT versions wrote. A file QSMxT would refuse is refused with its reason.
pub fn config_from_toml(toml: &str) -> Result<String, String> {
    let (mut config, warnings) =
        PipelineConfig::from_toml_migrating(toml).map_err(|e| e.to_string())?;
    config.apply_browser_profile();
    let config: Value = serde_json::to_value(&config).map_err(|e| e.to_string())?;
    Ok(json!({ "config": config, "warnings": warnings }).to_string())
}

/// [`config_from_toml`].
#[wasm_bindgen]
pub fn config_from_toml_wasm(toml: &str) -> Result<String, JsValue> {
    config_from_toml(toml).map_err(js_err)
}

/// A configuration the page saved (PipelineConfig JSON, possibly from an earlier version of the
/// page), read as QSMxT reads a saved JSON config (`PipelineConfig::from_json_migrating`: one
/// without `schema_version` is brought up to date as an older settings file is), then given the
/// browser profile: `{ config, warnings }`, as [`config_from_toml`]. A config QSMxT would refuse
/// is refused with its reason.
pub fn config_from_json(json: &str) -> Result<String, String> {
    let (mut config, migration) =
        PipelineConfig::from_json_migrating(json).map_err(|e| e.to_string())?;
    config.apply_browser_profile();
    let warnings: Vec<String> = migration
        .warnings
        .into_iter()
        .chain(migration.notes)
        .collect();
    let config: Value = serde_json::to_value(&config).map_err(|e| e.to_string())?;
    Ok(json!({ "config": config, "warnings": warnings }).to_string())
}

/// [`config_from_json`].
#[wasm_bindgen]
pub fn config_from_json_wasm(json: &str) -> Result<String, JsValue> {
    config_from_json(json).map_err(js_err)
}

// ============================================================================
// The pipeline graph and the items
// ============================================================================

/// The pipeline `qsmxt run` will take for `config` on the scan `facts` describes, as a graph
/// (`pipeline_graph` of the run's `plan`): `{ nodes, edges, items, two_pass, mermaid }`, `mermaid`
/// being `PipelineGraph::to_mermaid()`. `grid_json` is the run's grid (RunMetadata JSON) once a
/// scan is loaded; without it, the return to the acquired grid is drawn as conditional.
pub fn graph(
    config_json: &str,
    facts_json: &str,
    grid_json: Option<&str>,
) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let facts = parse_facts(facts_json)?;
    let grid: Option<RunMetadata> = grid_json
        .map(|g| serde_json::from_str(g).map_err(|e| format!("grid JSON is not RunMetadata: {e}")))
        .transpose()?;
    graph_json(&config, &facts, grid.as_ref())
}

pub(crate) fn graph_json(
    config: &PipelineConfig,
    facts: &ScanFacts,
    grid: Option<&RunMetadata>,
) -> Result<String, String> {
    let plan = qsmxt_engine::plan::plan(config, facts);
    let graph = pipeline_graph(&plan, config, facts, grid);
    let mut value = serde_json::to_value(&graph).map_err(|e| e.to_string())?;
    value["mermaid"] = graph.to_mermaid().into();
    Ok(value.to_string())
}

/// [`graph`].
#[wasm_bindgen]
pub fn pipeline_graph_wasm(
    config_json: &str,
    facts_json: &str,
    grid_json: Option<String>,
) -> Result<String, JsValue> {
    graph(config_json, facts_json, grid_json.as_deref()).map_err(js_err)
}

/// The methods text of a run of `config` on the scan `facts` describes, sentence by sentence
/// (`methods::methods_structured` for "QSMbly", on the same plan as [`graph`]):
/// `{ sentences: [{ text, steps, citations }], references: [{ key, text }] }`, each sentence's
/// `steps` being the ids of the graph's boxes it describes.
pub fn methods(config_json: &str, facts_json: &str) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let facts = parse_facts(facts_json)?;
    let plan = qsmxt_engine::plan::plan(&config, &facts);
    serde_json::to_string(&qsmxt_engine::methods::methods_structured(
        &config, &plan, "QSMbly",
    ))
    .map_err(|e| e.to_string())
}

/// [`methods`].
#[wasm_bindgen]
pub fn methods_structured_wasm(config_json: &str, facts_json: &str) -> Result<String, JsValue> {
    methods(config_json, facts_json).map_err(js_err)
}

fn parse_record(record_json: &str) -> Result<RunRecord, String> {
    serde_json::from_str(record_json).map_err(|e| format!("the run record is not valid: {e}"))
}

/// The pipeline a run of `config` on the scan `facts` describes took, as `record` (what
/// `Engine.run` returned) says: [`graph`]'s JSON with each box's `run` (`{ state, decisions }`:
/// `computed`, `cached` or `skipped`, and what the step decided, each `{ topic, choice, reason,
/// detail }`), and `differs`: whether it differs from the planned graph (a box or arrow drawn
/// differently, or a step that did nothing; reusing the cache is no difference).
pub fn graph_after(
    config_json: &str,
    facts_json: &str,
    record_json: &str,
) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let facts = parse_facts(facts_json)?;
    let record = parse_record(record_json)?;
    let plan = qsmxt_engine::plan::plan(&config, &facts);
    let planned = pipeline_graph_on(&plan, &config, &facts, record.resampled);
    let after = pipeline_graph_after(&plan, &config, &facts, &record);
    let mut value = serde_json::to_value(&after).map_err(|e| e.to_string())?;
    value["mermaid"] = after.to_mermaid().into();
    value["differs"] = after.differs_from(&planned).into();
    Ok(value.to_string())
}

/// [`graph_after`].
#[wasm_bindgen]
pub fn pipeline_graph_after_wasm(
    config_json: &str,
    facts_json: &str,
    record_json: &str,
) -> Result<String, JsValue> {
    graph_after(config_json, facts_json, record_json).map_err(js_err)
}

/// The methods text of a run of `config` on the scan `facts` describes that did what `record`
/// says (`methods::methods_for_run` for "QSMbly"), in [`methods`]' shape: what was done, including
/// what the run decided (a supplied mask used, or computed when it could not be).
pub fn methods_after(
    config_json: &str,
    facts_json: &str,
    record_json: &str,
) -> Result<String, String> {
    let config = parse_config(config_json)?;
    let facts = parse_facts(facts_json)?;
    let record = parse_record(record_json)?;
    let plan = qsmxt_engine::plan::plan(&config, &facts);
    serde_json::to_string(&qsmxt_engine::methods::methods_for_run(
        &config, &plan, &record, "QSMbly",
    ))
    .map_err(|e| e.to_string())
}

/// [`methods_after`].
#[wasm_bindgen]
pub fn methods_for_run_wasm(
    config_json: &str,
    facts_json: &str,
    record_json: &str,
) -> Result<String, JsValue> {
    methods_after(config_json, facts_json, record_json).map_err(js_err)
}

/// What the item kept under `key` is (`Item::meta`, with its `key` and serialised `item`):
/// `{ key, item, label, units, kind, bids_name, published, echo, coil }`; `None` for a key that
/// names no item.
pub fn item_meta(key: &str) -> Option<String> {
    Item::from_key(key).map(|item| item_info(&item).to_string())
}

/// [`item_meta`]: JSON, or `undefined`.
#[wasm_bindgen]
pub fn item_meta_wasm(key: &str) -> Option<String> {
    item_meta(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser() -> String {
        browser_config().unwrap()
    }

    fn example_facts() -> String {
        json!({
            "dims": [184, 256, 128], "n_echoes": 5,
            "echo_times": [0.005, 0.011, 0.017, 0.023, 0.029], "has_magnitude": true,
            "n_coils": 1, "real_imaginary": false, "field_strength": 2.8946,
            "b0_dir": [0.0, 0.0, 1.0], "mese_echo_times": null, "custom_mask": false,
            "custom_dseg": false, "custom_qsm": false, "custom_r2": false, "custom_r2prime": false,
        })
        .to_string()
    }

    fn set(config: &str, path: &str, value: Value) -> String {
        set_setting(config, path, &value.to_string()).unwrap()
    }

    fn view(config: &str) -> Vec<Value> {
        serde_json::from_str(&settings_view(config, Some(&example_facts()), false).unwrap())
            .unwrap()
    }

    fn row<'a>(rows: &'a [Value], path: &str) -> &'a Value {
        rows.iter().find(|r| r["path"] == path).unwrap()
    }

    /// The findings on a setting: `[(rule, strength, departs, dismissed)]`.
    fn findings(config: &str, path: &str) -> Vec<(String, String, bool, bool)> {
        row(&view(config), path)["recommendations"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|r| {
                        (
                            r["rule"].as_str().unwrap().to_string(),
                            r["strength"].as_str().unwrap().to_string(),
                            r["departs"] == true,
                            r["dismissed"] == true,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// NDI's echo time moved off the first echo: a recommended finding, which Apply resolves,
    /// Ignore dismisses for that value, and pruning drops once the value changes.
    #[test]
    fn the_rules_findings_are_applied_dismissed_and_pruned_by_the_engine() {
        let ndi = set(&browser(), "inversion.algorithm", json!("ndi"));
        let last = set(&ndi, "inversion.ndi.te", json!("last"));
        let rule = "ndi.te-first";
        assert_eq!(
            findings(&last, "inversion.ndi.te"),
            vec![(rule.to_string(), "recommended".into(), true, false)]
        );
        // The reference value shows at the default too, departed from or not.
        let rows = view(&ndi);
        let reference = &row(&rows, "inversion.ndi.te")["reference"];
        assert_eq!(reference[0]["rule"], rule);
        assert_eq!(reference[0]["departs"], false);

        let applied = apply_recommendation(&last, rule, None).unwrap();
        assert!(findings(&applied, "inversion.ndi.te").is_empty());
        let picked = apply_recommendation(&last, rule, Some("\"first\"")).unwrap();
        assert!(findings(&picked, "inversion.ndi.te").is_empty());
        assert!(apply_recommendation(&last, "no.such-rule", None).is_err());

        let facts = example_facts();
        let dismissed = dismiss_recommendation(&last, rule, Some(&facts), false).unwrap();
        assert_eq!(
            findings(&dismissed, "inversion.ndi.te"),
            vec![(rule.to_string(), "recommended".into(), true, true)]
        );
        let saved: Value = serde_json::from_str(&dismissed).unwrap();
        assert_eq!(
            saved["dismissed_recommendations"],
            json!([{ "rule": rule, "chosen": "last" }])
        );
        assert_eq!(
            prune_dismissals(&dismissed, Some(&facts), false).unwrap(),
            dismissed,
            "kept while the setting keeps the value"
        );
        // Changed and changed back: the dismissal went with the change, and the finding is back.
        let moved = prune_dismissals(
            &set(&dismissed, "inversion.ndi.te", json!("sum")),
            Some(&facts),
            false,
        )
        .unwrap();
        let back = set(&moved, "inversion.ndi.te", json!("last"));
        assert_eq!(
            findings(&back, "inversion.ndi.te"),
            vec![(rule.to_string(), "recommended".into(), true, false)]
        );
        assert_eq!(
            undismiss_recommendation(&dismissed, rule).unwrap(),
            set(&last, "inversion.ndi.te", json!("last"))
        );
        // Nothing to dismiss where nothing departs.
        assert!(dismiss_recommendation(&ndi, rule, Some(&facts), false).is_err());
    }

    /// Choosing MEDI chooses a method with a reference pipeline: the bindings name it, offer where
    /// the config differs from it under its title, and Keep mine and Apply all each leave nothing
    /// to offer. The view's marker says whose rule a setting departs from.
    #[test]
    fn a_chosen_methods_reference_pipeline_is_offered_kept_or_applied() {
        let facts = example_facts();
        let methods = |c: &str| -> Vec<Value> {
            serde_json::from_str(&chosen_methods(c, Some(&facts), false).unwrap()).unwrap()
        };
        let before = methods(&browser());
        let medi = set(&browser(), "inversion.algorithm", json!("medi"));
        let chosen: Vec<Value> = methods(&medi)
            .into_iter()
            .filter(|m| !before.contains(m))
            .collect();
        assert!(chosen.iter().any(|m| m["name"] == "MEDI"), "{chosen:?}");
        let chosen = Value::from(chosen).to_string();
        let offers = |c: &str| -> Vec<Value> {
            serde_json::from_str(&reference_offers(c, Some(&facts), false, &chosen).unwrap())
                .unwrap()
        };
        let differences = |c: &str| -> Vec<Value> {
            offers(c)
                .iter()
                .flat_map(|o| o["differences"].as_array().unwrap().clone())
                .collect()
        };
        let first = offers(&medi);
        let titled = first
            .iter()
            .find(|o| o["method"]["name"] == "MEDI")
            .unwrap();
        assert_eq!(titled["title"], "MEDI's reference pipeline");
        let found = differences(&medi);
        assert!(
            !found.is_empty(),
            "the browser profile differs from MEDI's reference"
        );
        let found = Value::from(found).to_string();
        assert!(differences(&keep_findings(&medi, &found).unwrap()).is_empty());
        assert!(differences(&apply_all(&medi, &found).unwrap()).is_empty());
        assert_eq!(
            reference_titles(&chosen).unwrap(),
            Value::from(
                serde_json::from_str::<Vec<Value>>(&chosen)
                    .unwrap()
                    .iter()
                    .map(|m| format!("{}'s reference pipeline", m["name"].as_str().unwrap()))
                    .collect::<Vec<_>>()
            )
            .to_string()
        );
        // The defaults depart from iLSQR's reference unwrapping: an information marker naming it.
        let unwrap = row(&view(&browser()), "field_mapping.unwrapping_algorithm").clone();
        assert_eq!(unwrap["marker"]["actionable"], false);
        assert!(
            unwrap["marker"]["text"]
                .as_str()
                .unwrap()
                .starts_with("iLSQR: "),
            "{unwrap}"
        );
        assert!(keep_findings(&medi, "not json").is_err());
    }

    /// The scan's field strength, matrix and voxel size reach the rules only for a loaded scan.
    #[test]
    fn a_loaded_scans_facts_reach_the_rules() {
        let mut facts: Value = serde_json::from_str(&example_facts()).unwrap();
        facts["voxel_size"] = json!([1.0, 1.0, 2.0]);
        let facts = facts.to_string();
        assert_eq!(
            view_facts(Some(&facts), false).unwrap().field_strength,
            None
        );
        let loaded = view_facts(Some(&facts), true).unwrap();
        assert_eq!(loaded.field_strength, Some(2.8946));
        assert_eq!(loaded.dims, Some([184, 256, 128]));
        assert_eq!(loaded.voxel_size, Some([1.0, 1.0, 2.0]));
        assert_eq!(loaded.num_echoes, Some(5));
        assert_eq!(loaded.has_magnitude, Some(true));
    }

    #[test]
    fn the_schema_and_the_browser_profile_are_the_engines() {
        let schema: Value = serde_json::from_str(&schema_json_wasm()).unwrap();
        assert!(schema["settings"].as_array().unwrap().len() > 200);
        assert!(schema["mask"]["steps"].as_array().is_some());
        let config = parse_config(&browser()).unwrap();
        assert_eq!(
            config.to_json().unwrap(),
            PipelineConfig::browser().to_json().unwrap()
        );
        // The profile is idempotent.
        assert_eq!(apply_browser_profile(&browser()).unwrap(), browser());
    }

    #[test]
    fn the_browsers_mask_defaults_run_hd_bet_as_a_window() {
        let d: Value = serde_json::from_str(&browser_mask_defaults().unwrap()).unwrap();
        let window = json!(qsmxt_engine::hd_bet_low_memory_patch());
        assert_eq!(d["steps"]["hd-bet"]["patch"], window);
        assert_eq!(
            d["presets"]["hd-bet"]["sections"][0]["generator"]["patch"],
            window
        );
        assert_eq!(
            d["steps"]["erode"],
            json!({ "op": "erode", "iterations": 1 })
        );
        assert_eq!(
            d["two_pass_sections"],
            json!(qsmxt_engine::default_two_pass_sections())
        );
        let robust = &d["presets"]["robust-threshold"];
        let browser: Value = serde_json::from_str(&browser()).unwrap();
        assert_eq!(robust["sections"], browser["masking"]["sections"]);
    }

    #[test]
    fn settings_view_reports_the_engines_errors() {
        let rows = view(&set(&browser(), "inversion.algorithm", json!("tkd")));
        let tkd = rows
            .iter()
            .find(|r| r["path"] == "inversion.tkd.threshold")
            .unwrap();
        assert_eq!(tkd["visible"], true);
        assert!(tkd["error"].is_null());
        let config = set(
            &set(&browser(), "inversion.algorithm", json!("tkd")),
            "inversion.tkd.threshold",
            json!(0.0),
        );
        let rows = view(&config);
        let tkd = rows
            .iter()
            .find(|r| r["path"] == "inversion.tkd.threshold")
            .unwrap();
        assert!(
            tkd["error"].as_str().is_some_and(|e| !e.is_empty()),
            "{tkd}"
        );
        // Without facts every setting the data could need applies.
        assert!(settings_view(&browser(), None, false).is_ok());
    }

    #[test]
    fn set_refuses_what_the_config_refuses() {
        let e = set_setting(&browser(), "inversion.algorithm", "\"no-such\"").unwrap_err();
        assert!(e.starts_with("inversion.algorithm"), "{e}");
        assert!(set_setting(&browser(), "no.such.path", "1").is_err());
        let config = set(&browser(), "bg_removal.vsharp.max_radius", json!(10.0));
        assert_eq!(
            get_setting(&config, "bg_removal.vsharp.max_radius")
                .unwrap()
                .as_deref(),
            Some("10.0")
        );
        assert_eq!(get_setting(&config, "no.such").unwrap(), None);
    }

    #[test]
    fn prune_hidden_resets_settings_that_do_not_apply() {
        // A V-SHARP radius left behind by a switch to PDF does not apply, and goes back.
        let config = set(
            &set(&browser(), "bg_removal.vsharp.max_radius", json!(10.0)),
            "bg_removal.algorithm",
            json!("pdf"),
        );
        let pruned = prune_hidden(&config, Some(&example_facts())).unwrap();
        assert_eq!(
            get_setting(&pruned, "bg_removal.vsharp.max_radius")
                .unwrap()
                .as_deref(),
            Some("12.0")
        );
    }

    #[test]
    fn the_command_and_the_toml_are_the_engines() {
        let config = set(&browser(), "inversion.algorithm", json!("rts"));
        assert!(command(&config).unwrap().contains("--qsm-algorithm rts"));
        let toml = config_to_toml(&config, true).unwrap();
        assert!(toml.contains("[inversion.rts]") && !toml.contains("[inversion.tkd]"));
        assert!(config_to_toml(&config, false)
            .unwrap()
            .contains("[inversion.tkd]"));
        let back: Value = serde_json::from_str(&config_from_toml(&toml).unwrap()).unwrap();
        assert_eq!(
            back["config"],
            serde_json::from_str::<Value>(&config).unwrap()
        );
        assert_eq!(back["warnings"], json!([]));
        // A native config gets the browser profile; a broken one is refused with the reason.
        let native = config_from_toml(&PipelineConfig::default().to_toml().unwrap()).unwrap();
        let native: Value = serde_json::from_str(&native).unwrap();
        assert_eq!(
            native["config"],
            serde_json::from_str::<Value>(&browser()).unwrap()
        );
        assert!(config_from_toml("[inversion]\nalgorithm = 3\n").is_err());
        let old: Value = serde_json::from_str(
            &config_from_toml("[pipeline]\nobliquity_threshold = -1\n").unwrap(),
        )
        .unwrap();
        assert_eq!(old["warnings"].as_array().unwrap().len(), 1);
    }

    /// A saved config is read back as it was saved; one saved before configs carried
    /// `schema_version` is brought up to date by the engine, with its notes.
    #[test]
    fn a_saved_config_is_read_through_the_engines_migration() {
        let config = set(&browser(), "inversion.algorithm", json!("rts"));
        let back: Value = serde_json::from_str(&config_from_json(&config).unwrap()).unwrap();
        assert_eq!(
            back["config"],
            serde_json::from_str::<Value>(&config).unwrap()
        );
        assert_eq!(back["warnings"], json!([]));
        // Saved by an earlier page: no schema_version, and TGV's tolerance (gone since).
        let mut old: Value = serde_json::from_str(&browser()).unwrap();
        old.as_object_mut().unwrap().remove("schema_version");
        old["inversion"]["tgv"]["tol"] = json!(1e-5);
        let back: Value =
            serde_json::from_str(&config_from_json(&old.to_string()).unwrap()).unwrap();
        assert_eq!(
            back["config"]["schema_version"],
            json!(qsmxt_engine::migrate::CONFIG_SCHEMA_VERSION)
        );
        assert!(back["config"]["inversion"]["tgv"].get("tol").is_none());
        assert!(config_from_json("{ not json").is_err());
    }

    /// The short settings file holds the browser profile's and the user's changes from QSMxT's
    /// defaults, and nothing else: read by `qsmxt run --config`, it is the same run.
    #[test]
    fn the_short_toml_is_what_differs_from_qsmxts_defaults() {
        let config = set(&browser(), "inversion.algorithm", json!("rts"));
        let short = config_to_toml_changed(&config).unwrap();
        assert!(short.contains("algorithm = \"rts\""), "{short}");
        assert!(!short.contains("[inversion.tkd]"), "{short}");
        let full = config_to_toml(&config, false).unwrap();
        assert!(short.lines().count() * 4 < full.lines().count(), "{short}");
        let back = PipelineConfig::from_toml(&short).unwrap();
        assert_eq!(
            qsmxt_engine::generate_command(&back),
            command(&config).unwrap(),
            "the short file and the command set the same run"
        );
    }

    #[test]
    fn the_graph_is_the_plans() {
        let tgv = set(&browser(), "inversion.algorithm", json!("tgv"));
        let g: Value = serde_json::from_str(&graph(&tgv, &example_facts(), None).unwrap()).unwrap();
        let ids: Vec<&str> = g["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap())
            .collect();
        assert!(!ids.contains(&"bgremove"), "{ids:?}");
        assert!(g["mermaid"].as_str().unwrap().starts_with("flowchart TD"));
        assert!(g["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["key"] == "Chi"));
    }

    #[test]
    fn the_methods_name_the_graphs_boxes() {
        let two_pass = set(&browser(), "masking.two_pass", json!(true));
        let m: Value =
            serde_json::from_str(&methods(&two_pass, &example_facts()).unwrap()).unwrap();
        let g: Value =
            serde_json::from_str(&graph(&two_pass, &example_facts(), None).unwrap()).unwrap();
        let ids: Vec<&str> = g["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap())
            .collect();
        let sentences = m["sentences"].as_array().unwrap();
        assert!(sentences[0]["text"].as_str().unwrap().contains("QSMbly"));
        for s in sentences {
            for id in s["steps"].as_array().unwrap() {
                assert!(
                    ids.contains(&id.as_str().unwrap()),
                    "{id} is not a box: {ids:?}"
                );
            }
        }
        let inversion = sentences
            .iter()
            .find(|s| s["text"].as_str().unwrap().starts_with("Dipole inversion"))
            .unwrap();
        assert_eq!(inversion["steps"], json!(["invert", "invert-reliable"]));
        assert!(!m["references"].as_array().unwrap().is_empty());
    }

    #[test]
    fn item_meta_names_the_engines_items() {
        let chi: Value = serde_json::from_str(&item_meta("Chi").unwrap()).unwrap();
        assert_eq!(chi["units"], "ppm");
        assert_eq!(chi["kind"], "chi");
        let phase: Value = serde_json::from_str(&item_meta("AcquiredPhase(3)").unwrap()).unwrap();
        assert_eq!(phase["echo"], 3);
        assert!(item_meta("NoSuchItem").is_none());
    }

    /// A scan in memory: a sphere of tissue in a 16³ box at 1 mm, three echoes, a smooth local
    /// field inside it wrapped into the phase, a magnitude bright inside and dark outside.
    fn phantom() -> (
        qsmxt_engine::scan::ScanFacts,
        qsmxt_engine::store::MemoryStore,
    ) {
        use qsmxt_engine::observe::VolumeData;
        use qsmxt_engine::store::{Header, MemoryStore};
        const N: usize = 16;
        let tes = [0.005, 0.010, 0.015];
        let mut affine = [0.0; 16];
        for i in 0..4 {
            affine[5 * i] = 1.0;
        }
        let header = Header {
            dims: (N, N, N),
            voxel_size: (1.0, 1.0, 1.0),
            affine,
            sidecar: None,
        };
        let mut store = MemoryStore::new(header, json!("phantom-1"));
        let c = (N as f64 - 1.0) / 2.0;
        let (mut field_hz, mut magnitude) = (vec![0.0; N * N * N], vec![0.0; N * N * N]);
        for z in 0..N {
            for y in 0..N {
                for x in 0..N {
                    let i = x + y * N + z * N * N;
                    let (dx, dy, dz) = (x as f64 - c, y as f64 - c, z as f64 - c);
                    if dx * dx + dy * dy + dz * dz < 36.0 {
                        field_hz[i] = 3.0 * (dx / 6.0) + 2.0 * (dz / 6.0);
                        magnitude[i] = 100.0;
                    } else {
                        magnitude[i] = 1.0;
                    }
                }
            }
        }
        for (e, te) in tes.iter().enumerate() {
            let phase: Vec<f64> = field_hz
                .iter()
                .map(|f| {
                    let p = 2.0 * std::f64::consts::PI * f * te;
                    (p + std::f64::consts::PI).rem_euclid(2.0 * std::f64::consts::PI)
                        - std::f64::consts::PI
                })
                .collect();
            store.insert(Item::AcquiredPhase(e + 1), VolumeData::Real(phase));
            store.insert(
                Item::AcquiredMagnitude(e + 1),
                VolumeData::Real(magnitude.clone()),
            );
        }
        let facts: ScanFacts = serde_json::from_value(json!({
            "dims": [N, N, N], "n_echoes": 3, "echo_times": tes, "has_magnitude": true,
            "n_coils": 1, "real_imaginary": false, "field_strength": 3.0, "b0_dir": [0.0, 0.0, 1.0],
            "mese_echo_times": null, "custom_mask": false, "custom_dseg": false, "custom_qsm": false,
            "custom_r2": false, "custom_r2prime": false,
        }))
        .unwrap();
        (facts, store)
    }

    /// Run `config` on the phantom in memory, as `Engine.run` does: the record's JSON. With
    /// `QSMBLY_WRITE_RUN_FIXTURES` set, `js/next/fixtures/<name>` gets the recorded run the page's
    /// tests show, on the example scan (`facts` as the example's, `custom_mask` from `facts`):
    /// `{ config, facts, record, graph, methods }`, the last two as the bindings answer them.
    fn recorded_run(
        name: &str,
        config: &PipelineConfig,
        facts: &ScanFacts,
        store: &mut qsmxt_engine::store::MemoryStore,
    ) -> String {
        let plan = qsmxt_engine::plan::plan(config, facts);
        let record = qsmxt_engine::run::run(&plan, config, facts, store, &mut ()).unwrap();
        let json = serde_json::to_string(&record).unwrap();
        if std::env::var_os("QSMBLY_WRITE_RUN_FIXTURES").is_some() {
            let mut example: Value = serde_json::from_str(&example_facts()).unwrap();
            example["custom_mask"] = facts.custom_mask.into();
            let (c, f) = (config.to_json().unwrap(), example.to_string());
            let fixture = json!({
                "config": serde_json::from_str::<Value>(&c).unwrap(),
                "facts": example,
                "record": record,
                "graph": serde_json::from_str::<Value>(&graph_after(&c, &f, &json).unwrap()).unwrap(),
                "methods": serde_json::from_str::<Value>(&methods_after(&c, &f, &json).unwrap()).unwrap(),
            });
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../js/next/fixtures")
                .join(name);
            std::fs::write(
                path,
                format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap()),
            )
            .unwrap();
        }
        json
    }

    /// A run in memory with the browser's settings: its record reaches the graph after the run
    /// (each box with what its step did) and the methods text, as the bindings give them; nothing
    /// was decided that the plan did not know, so the graph does not differ from the planned one.
    #[test]
    fn a_runs_record_draws_the_graph_after_it_and_its_methods() {
        let (facts, mut store) = phantom();
        let config = PipelineConfig::browser();
        let record = recorded_run("run-as-planned.json", &config, &facts, &mut store);
        let (config_json, facts_json) = (
            config.to_json().unwrap(),
            serde_json::to_string(&facts).unwrap(),
        );
        let after: Value =
            serde_json::from_str(&graph_after(&config_json, &facts_json, &record).unwrap())
                .unwrap();
        assert_eq!(after["differs"], false);
        let nodes = after["nodes"].as_array().unwrap();
        assert!(
            nodes.iter().all(|n| n["run"]["state"] == "computed"),
            "{nodes:?}"
        );
        assert!(after["mermaid"].as_str().unwrap().contains("computed"));
        // The same methods as planned; the run's Note may say more, since the run's own scan
        // reaches the rules (its echo count, say) where the planned Note has only the config.
        let after: Value =
            serde_json::from_str(&methods_after(&config_json, &facts_json, &record).unwrap())
                .unwrap();
        let planned: Value =
            serde_json::from_str(&super::methods(&config_json, &facts_json).unwrap()).unwrap();
        assert_eq!(after["sentences"], planned["sentences"]);
        assert_eq!(after["references"], planned["references"]);
        for line in planned["note"]["differences"]
            .as_array()
            .into_iter()
            .flatten()
        {
            assert!(
                after["note"]["differences"]
                    .as_array()
                    .is_some_and(|a| a.contains(line)),
                "{line} is in the planned Note but not the run's"
            );
        }
        // The record fits the example's plan too, which the page's tests show it on.
        let example: Vec<Value> = serde_json::from_str::<Value>(
            &super::graph(&browser(), &example_facts(), None).unwrap(),
        )
        .unwrap()["nodes"]
            .as_array()
            .unwrap()
            .clone();
        // (Without its grid, the return to the acquired grid is drawn conditional; the run was not
        // resampled.)
        let ids = |nodes: &[Value]| {
            nodes
                .iter()
                .map(|n| n["id"].clone())
                .filter(|id| id != "output_space")
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(nodes), ids(&example));
    }

    /// A supplied mask that cannot be brought onto the run's grid is computed instead: the graph
    /// after the run differs from the planned one (the mask is drawn computed from the echoes,
    /// with the reason on its box), and the methods text describes the recipe that ran.
    #[test]
    fn a_supplied_mask_the_run_could_not_use_shows_in_the_graph_and_the_methods() {
        use qsmxt_engine::store::Supplied;
        let (mut facts, mut store) = phantom();
        let mut config = PipelineConfig::browser();
        config.masking.custom_mask_tool = Some("qsmbly".into());
        facts.custom_mask = true;
        let mut far = [0.0; 16];
        for i in 0..4 {
            far[5 * i] = 1.0;
        }
        far[3] = 1000.0;
        store.supply_mask(Supplied::Found {
            origin: "drawn mask".into(),
            data: vec![1.0; 8],
            dims: (2, 2, 2),
            affine: far,
        });
        let record = recorded_run("run-mask-computed.json", &config, &facts, &mut store);
        let (config_json, facts_json) = (
            config.to_json().unwrap(),
            serde_json::to_string(&facts).unwrap(),
        );
        let after: Value =
            serde_json::from_str(&graph_after(&config_json, &facts_json, &record).unwrap())
                .unwrap();
        assert_eq!(after["differs"], true);
        let mask = after["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "mask")
            .unwrap()
            .clone();
        assert_eq!(mask["run"]["decisions"][0]["choice"], "computed");
        assert!(mask["reads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "Phase(1)"));
        let methods: Value =
            serde_json::from_str(&methods_after(&config_json, &facts_json, &record).unwrap())
                .unwrap();
        let text: Vec<&str> = methods["sentences"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["text"].as_str().unwrap())
            .collect();
        assert!(
            !text.iter().any(|t| t.starts_with("Where available")),
            "{text:?}"
        );
        assert!(super::methods(&config_json, &facts_json)
            .unwrap()
            .contains("Where available"));
    }
}
