//! The interpreter of the command table: the Rust counterpart of
//! `packages/cryo-em/src/spec.js`. It reaches the same decisions with the same
//! messages (`validation-cases.json`) and writes the same command lines
//! (`argv-cases.json`). Function names follow `spec.js`.

use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::definition::{
    definition, Accept, Arg, Command, Comparison, Condition, Derived, Input, LaunchRule, OptionDef,
    OptionKind, ProgressKind,
};
use crate::roots::{valid_root_id, MAX_PATH_BYTES, MAX_PATTERN_BYTES};
use crate::tools::LogLevel;

const SPEC_KEYS: [&str; 6] = ["tool", "command", "project", "profile", "inputs", "options"];

/// A validated input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InputValue {
    /// A project-relative file of an earlier job.
    Path(String),
    /// An uploaded part, stored as `<directory>/<part>.mrc`.
    Part { part: String },
    /// Files of one directory of a data root.
    DataRoot {
        root: String,
        path: String,
        pattern: String,
    },
    /// One file of a data root.
    DataFile { root: String, path: String },
}

/// A spec that passed validation, with every applicable option filled in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Validated {
    /// `relion`.
    pub tool: String,
    /// The command id.
    pub command: String,
    /// The project id.
    pub project: String,
    /// The requested profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Given inputs.
    pub inputs: BTreeMap<String, InputValue>,
    /// Applicable options.
    pub options: Map<String, Value>,
}

impl Validated {
    /// The command's table entry.
    pub fn entry(&self) -> &'static Command {
        definition()
            .commands
            .get(&self.command)
            .expect("validated commands exist")
    }

    /// Inputs in the table's order.
    pub fn ordered_inputs(&self) -> impl Iterator<Item = (&'static str, &InputValue)> {
        self.entry()
            .inputs
            .iter()
            .filter_map(|(name, _)| self.inputs.get(name).map(|value| (name, value)))
    }

    /// A number option.
    pub fn number(&self, name: &str) -> f64 {
        self.options
            .get(name)
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    }

    /// An integer option.
    pub fn int(&self, name: &str) -> i64 {
        self.number(name) as i64
    }

    /// A boolean option.
    pub fn flag(&self, name: &str) -> bool {
        self.options
            .get(name)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// A string option.
    pub fn text(&self, name: &str) -> &str {
        self.options.get(name).and_then(Value::as_str).unwrap_or("")
    }

    /// An integer list option.
    pub fn ints(&self, name: &str) -> Vec<i64> {
        self.options
            .get(name)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_f64)
                    .map(|item| item as i64)
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// How a command runs on a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Launch {
    /// MPI ranks; more than one runs under `mpirun`.
    pub mpi_ranks: u32,
    /// `--j`.
    pub threads: u32,
    /// GPUs the command uses.
    pub gpus: u32,
}

/// One program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
}

/// `relionCommand`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLine {
    pub program: String,
    pub args: Vec<String>,
    pub launch: Launch,
    pub then: Vec<Program>,
}

/// The command ids in table order.
pub fn relion_commands() -> &'static [&'static str] {
    static COMMANDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    COMMANDS.get_or_init(|| definition().commands.iter().map(|(name, _)| name).collect())
}

fn command_definition(command: &str) -> Result<&'static Command, String> {
    definition()
        .commands
        .get(command)
        .ok_or_else(|| format!("command must be one of {}", relion_commands().join(", ")))
}

/// `Class2D` for `class2d`.
pub fn job_type_directory(command: &str) -> Result<&'static str, String> {
    command_definition(command).map(|entry| entry.job_type.as_str())
}

/// JavaScript's `String(number)` for the numbers of messages.
pub fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == value.trunc() && value.abs() < 1e21 {
        return format!("{}", value as i128);
    }
    format!("{value}")
}

fn json_number(number: &serde_json::Number) -> String {
    js_number(number.as_f64().unwrap_or(f64::NAN))
}

/// A `number` option as typed into RELION's GUI, which passes the text on
/// unchanged: the shortest decimal that reads back as the same double, without
/// an exponent (`typedNumber`). Negative zero is `0`.
pub fn typed_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    format!("{value}")
}

/// RELION's `floatToString`, for values the GUI computes: printf `%.6g` of the
/// float32 value, rounding the
/// exact value with ties to even. Negative zero is written as `0`.
pub fn relion_number(value: f64) -> String {
    let single = value as f32;
    if single == 0.0 {
        return "0".into();
    }
    let exact = f64::from(single);
    let scientific = format!("{exact:.5e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("exponential format has an e");
    let exponent: i32 = exponent.parse().expect("exponent is an integer");
    if !(-4..6).contains(&exponent) {
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!(
            "{}e{sign}{:02}",
            trim_zeros(mantissa),
            exponent.unsigned_abs()
        );
    }
    trim_zeros(&format!("{exact:.*}", (5 - exponent) as usize))
}

fn trim_zeros(text: &str) -> String {
    if !text.contains('.') {
        return text.to_string();
    }
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

// RELION's ROUND macro.
fn round(value: f64) -> f64 {
    if value > 0.0 {
        (value + 0.5).trunc()
    } else {
        (value - 0.5).trunc()
    }
}

/// The protocol's relative path rule (`checkRelativePath`).
pub fn check_relative_path(path: &Value, label: &str, allow_empty: bool) -> Result<(), String> {
    let Some(path) = path.as_str() else {
        return Err(format!("{label} must be a string"));
    };
    if path.is_empty() {
        if allow_empty {
            return Ok(());
        }
        return Err(format!("{label} must not be empty"));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(format!("{label} is longer than {MAX_PATH_BYTES} bytes"));
    }
    if path.contains('\\') || path.contains('\0') {
        return Err(format!("{label} must not contain a backslash or NUL"));
    }
    if path
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(format!(
            "{label} must be a relative path without empty, . or .. components"
        ));
    }
    Ok(())
}

fn check_pattern(pattern: &Value, label: &str) -> Result<(), String> {
    let pattern = match pattern.as_str() {
        Some(pattern) if !pattern.is_empty() => pattern,
        _ => return Err(format!("{label} must be a non-empty string")),
    };
    if pattern.len() > MAX_PATTERN_BYTES {
        return Err(format!("{label} is longer than {MAX_PATTERN_BYTES} bytes"));
    }
    if pattern.contains(['/', '\\', '\0', '[', ']']) {
        return Err(format!(
            "{label} must name files in one directory using only * and ? as wildcards"
        ));
    }
    Ok(())
}

/// What conditions read.
struct Context<'a> {
    options: &'a Map<String, Value>,
    inputs: &'a BTreeMap<String, InputValue>,
    gpus: u32,
}

fn to_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Null => 0.0,
        Value::String(text) if text.trim().is_empty() => 0.0,
        Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

// JavaScript's `===` on JSON values.
fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => false,
    }
}

// JavaScript's relational operators on JSON values.
fn compare(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    if let (Value::String(x), Value::String(y)) = (a, b) {
        return Some(x.encode_utf16().cmp(y.encode_utf16()));
    }
    to_number(a).partial_cmp(&to_number(b))
}

fn holds(condition: Option<&Condition>, context: &Context<'_>) -> Result<bool, String> {
    let Some(condition) = condition else {
        return Ok(true);
    };
    match condition {
        Condition::All(items) => {
            for item in items {
                if !holds(Some(item), context)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Condition::Not(inner) => Ok(!holds(Some(inner), context)?),
        Condition::Gpus(gpus) => Ok((context.gpus > 0) == *gpus),
        Condition::Input { name, present } => Ok(context.inputs.contains_key(name) == *present),
        Condition::Option {
            name,
            comparison,
            value: operand,
        } => {
            let value = context
                .options
                .get(name)
                .ok_or_else(|| format!("condition reads option {name}, which is not set"))?;
            use std::cmp::Ordering::{Equal, Greater, Less};
            let ordering = compare(value, operand);
            Ok(match comparison {
                Comparison::Eq => strict_equal(value, operand),
                Comparison::Ne => !strict_equal(value, operand),
                Comparison::Gt => ordering == Some(Greater),
                Comparison::Ge => matches!(ordering, Some(Greater | Equal)),
                Comparison::Lt => ordering == Some(Less),
                Comparison::Le => matches!(ordering, Some(Less | Equal)),
                Comparison::In => list_contains(operand, value),
                Comparison::NotIn => !list_contains(operand, value),
            })
        }
    }
}

fn list_contains(list: &Value, value: &Value) -> bool {
    list.as_array()
        .is_some_and(|items| items.iter().any(|item| strict_equal(item, value)))
}

fn describe(condition: &Condition) -> String {
    if let Condition::Option {
        name,
        comparison: Comparison::Eq,
        value,
    } = condition
    {
        return format!("{name} is {value}");
    }
    condition.to_json()
}

fn check_number(
    key: &str,
    value: &Value,
    option: &OptionDef,
    integer: bool,
) -> Result<f64, String> {
    let Some(number) = value.as_f64().filter(|number| number.is_finite()) else {
        return Err(format!("{key} must be a finite number"));
    };
    if integer && number.fract() != 0.0 {
        return Err(format!("{key} must be an integer"));
    }
    let below = option
        .min
        .as_ref()
        .is_some_and(|min| number < min.as_f64().unwrap_or(f64::NAN));
    let above = option
        .max
        .as_ref()
        .is_some_and(|max| number > max.as_f64().unwrap_or(f64::NAN));
    if below || above {
        let bound = |bound: &Option<serde_json::Number>| {
            bound
                .as_ref()
                .map(json_number)
                .unwrap_or_else(|| "undefined".into())
        };
        return Err(format!(
            "{key} must be in [{}, {}]",
            bound(&option.min),
            bound(&option.max)
        ));
    }
    if let Some(multiple) = &option.multiple_of {
        let divisor = multiple.as_f64().unwrap_or(f64::NAN);
        if number % divisor != 0.0 {
            return Err(format!(
                "{key} must be a multiple of {}",
                json_number(multiple)
            ));
        }
    }
    Ok(number)
}

fn integer_value(number: f64) -> Value {
    Value::from(number as i64)
}

// Checks one given option value; returns it normalised (integers as integers).
fn check_option_value(key: &str, value: &Value, option: &OptionDef) -> Result<Value, String> {
    match option.kind {
        OptionKind::Bool => {
            if !value.is_boolean() {
                return Err(format!("{key} must be a boolean"));
            }
            Ok(value.clone())
        }
        OptionKind::Int => check_number(key, value, option, true).map(integer_value),
        OptionKind::Number => check_number(key, value, option, false).map(|_| value.clone()),
        OptionKind::Enum => {
            let choices = option.choices.as_deref().unwrap_or_default();
            if !value
                .as_str()
                .is_some_and(|text| choices.iter().any(|choice| choice == text))
            {
                return Err(format!("{key} must be one of {}", choices.join(", ")));
            }
            Ok(value.clone())
        }
        OptionKind::String => {
            let pattern = option.pattern.as_deref().unwrap_or("");
            if !value
                .as_str()
                .is_some_and(|text| compiled(pattern).is_some_and(|regex| regex.is_match(text)))
            {
                return Err(format!("{key} must match {pattern}"));
            }
            Ok(value.clone())
        }
        OptionKind::IntList => {
            let (min_items, max_items) = (
                option.min_items.unwrap_or(0),
                option.max_items.unwrap_or(usize::MAX),
            );
            let items = value
                .as_array()
                .filter(|items| items.len() >= min_items && items.len() <= max_items)
                .ok_or_else(|| {
                    format!(
                        "{key} must list {} to {} integers",
                        option
                            .min_items
                            .map_or("undefined".into(), |count| count.to_string()),
                        option
                            .max_items
                            .map_or("undefined".into(), |count| count.to_string())
                    )
                })?;
            let mut seen: Vec<f64> = Vec::new();
            let mut normalised = Vec::new();
            for item in items {
                let number = check_number(&format!("{key} item"), item, option, true)?;
                if seen.contains(&number) {
                    return Err(format!("{key} lists {} twice", js_number(number)));
                }
                seen.push(number);
                normalised.push(integer_value(number));
            }
            Ok(Value::Array(normalised))
        }
    }
}

// Regular expressions of the table, compiled once.
fn compiled(pattern: &str) -> Option<&'static Regex> {
    static CACHE: OnceLock<std::sync::Mutex<BTreeMap<String, &'static Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(regex) = cache.get(pattern) {
        return Some(regex);
    }
    let regex: &'static Regex = Box::leak(Box::new(Regex::new(pattern).ok()?));
    cache.insert(pattern.to_string(), regex);
    Some(regex)
}

fn validate_options(entry: &Command, given: Option<&Value>) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let given = match given {
        None => &empty,
        Some(Value::Object(given)) => given,
        Some(_) => return Err("options must be an object".into()),
    };
    for key in given.keys() {
        if entry.options.get(key).is_none() {
            return Err(format!("unknown option {key}"));
        }
    }
    let mut options = Map::new();
    let no_inputs = BTreeMap::new();
    let ordered = entry
        .options
        .iter()
        .filter(|(_, option)| option.when.is_none())
        .chain(
            entry
                .options
                .iter()
                .filter(|(_, option)| option.when.is_some()),
        );
    for (key, option) in ordered {
        let value = given.get(key);
        let context = Context {
            options: &options,
            inputs: &no_inputs,
            gpus: 0,
        };
        if let Some(when) = &option.when {
            if !holds(Some(when), &context)? {
                if value.is_some() {
                    return Err(format!("option {key} applies only when {}", describe(when)));
                }
                continue;
            }
        }
        let Some(value) = value else {
            if option.required {
                return Err(format!("option {key} is required"));
            }
            options.insert(
                key.to_string(),
                option.default.clone().unwrap_or(Value::Null),
            );
            continue;
        };
        let checked = check_option_value(key, value, option)?;
        options.insert(key.to_string(), checked);
    }
    Ok(options)
}

fn job_component(component: &str) -> bool {
    component
        .strip_prefix("job")
        .is_some_and(|digits| digits.len() >= 3 && digits.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_path_input(name: &str, value: &Value, input: &Input) -> Result<InputValue, String> {
    let label = format!("inputs.{name}");
    check_relative_path(value, &label, false)?;
    let text = value.as_str().unwrap_or_default();
    let components: Vec<&str> = text.split('/').collect();
    if components.len() < 3 || !job_component(components[1]) {
        return Err(format!(
            "{label} must be a file of an earlier job, <Type>/jobNNN/<file>"
        ));
    }
    if !input.from.iter().any(|from| from == components[0]) {
        return Err(format!(
            "{label} must be an output of a {} job",
            input.from.join(" or ")
        ));
    }
    if let Some(suffix) = &input.suffix {
        if !text.ends_with(suffix.as_str()) {
            return Err(format!("{label} must end with {suffix}"));
        }
    }
    if let Some(pattern) = &input.pattern {
        if !compiled(pattern).is_some_and(|regex| regex.is_match(text)) {
            return Err(format!("{label} must contain {pattern}"));
        }
    }
    Ok(InputValue::Path(text.to_string()))
}

fn validate_input(
    name: &str,
    value: &Value,
    input: &Input,
    parts: &[&str],
) -> Result<InputValue, String> {
    let label = format!("inputs.{name}");
    let accepts = |kind: Accept| input.accept.contains(&kind);
    if accepts(Accept::Path) && value.is_string() {
        return validate_path_input(name, value, input);
    }
    let object = value.as_object();
    if let Some(object) =
        object.filter(|object| accepts(Accept::Part) && object.contains_key("part"))
    {
        if object.len() != 1 {
            return Err(format!("{label} must be {{ \"part\": \"{name}\" }}"));
        }
        if object.get("part").and_then(Value::as_str) != Some(name) {
            return Err(format!("{label}.part must be \"{name}\""));
        }
        if !parts.contains(&name) {
            return Err(format!("{label}.part must name an uploaded part"));
        }
        return Ok(InputValue::Part {
            part: name.to_string(),
        });
    }
    let root_of = |object: &Map<String, Value>| -> Result<String, String> {
        object
            .get("root")
            .and_then(Value::as_str)
            .filter(|root| valid_root_id(root))
            .map(str::to_string)
            .ok_or_else(|| format!("{label}.root must be a data root id"))
    };
    let missing = Value::Null;
    if let Some(object) = object.filter(|_| accepts(Accept::DataRoot)) {
        if let Some(key) = object
            .keys()
            .find(|key| !["root", "path", "pattern"].contains(&key.as_str()))
        {
            return Err(format!("{label} has unknown key {key}"));
        }
        let root = root_of(object)?;
        let path = object.get("path").unwrap_or(&missing);
        check_relative_path(path, &format!("{label}.path"), true)?;
        let pattern = object.get("pattern").unwrap_or(&missing);
        check_pattern(pattern, &format!("{label}.pattern"))?;
        return Ok(InputValue::DataRoot {
            root,
            path: path.as_str().unwrap_or_default().to_string(),
            pattern: pattern.as_str().unwrap_or_default().to_string(),
        });
    }
    if let Some(object) =
        object.filter(|object| accepts(Accept::DataFile) && !object.contains_key("pattern"))
    {
        if let Some(key) = object
            .keys()
            .find(|key| !["root", "path"].contains(&key.as_str()))
        {
            return Err(format!("{label} has unknown key {key}"));
        }
        let root = root_of(object)?;
        let path = object.get("path").unwrap_or(&missing);
        check_relative_path(path, &format!("{label}.path"), false)?;
        return Ok(InputValue::DataFile {
            root,
            path: path.as_str().unwrap_or_default().to_string(),
        });
    }
    let forms: Vec<String> = input
        .accept
        .iter()
        .map(|kind| kind.describe(name))
        .collect();
    Err(format!("{label} must be {}", forms.join(" or ")))
}

fn validate_inputs(
    entry: &Command,
    given: Option<&Value>,
    options: &Map<String, Value>,
    parts: &[&str],
) -> Result<BTreeMap<String, InputValue>, String> {
    let empty = Map::new();
    let given = match given {
        None => &empty,
        Some(Value::Object(given)) => given,
        Some(_) => return Err("inputs must be an object".into()),
    };
    for key in given.keys() {
        if entry.inputs.get(key).is_none() {
            return Err(format!("unknown input {key}"));
        }
    }
    let mut inputs = BTreeMap::new();
    let no_inputs = BTreeMap::new();
    let context = Context {
        options,
        inputs: &no_inputs,
        gpus: 0,
    };
    for (name, input) in entry.inputs.iter() {
        let value = given.get(name);
        if !holds(input.when.as_ref(), &context)? {
            if value.is_some() {
                let when = input.when.as_ref().map(describe).unwrap_or_default();
                return Err(format!("input {name} applies only when {when}"));
            }
            continue;
        }
        let Some(value) = value else {
            if !input.optional {
                return Err(format!("input {name} is required"));
            }
            continue;
        };
        inputs.insert(name.to_string(), validate_input(name, value, input, parts)?);
    }
    let used: HashSet<&str> = inputs
        .values()
        .filter_map(|value| match value {
            InputValue::Part { part } => Some(part.as_str()),
            _ => None,
        })
        .collect();
    if let Some(part) = parts.iter().find(|part| !used.contains(**part)) {
        return Err(format!("uploaded part {part} is not used by any input"));
    }
    Ok(inputs)
}

fn project_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn profile_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.len() <= 64
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
}

/// `validateRelionSpec`: checks a spec against the received part names and,
/// when given, the profile (`cpus`, `gpus`) it will run on.
pub fn validate_relion_spec(
    spec: &Value,
    parts: &[&str],
    profile: Option<(u32, u32)>,
) -> Result<Validated, String> {
    let Some(object) = spec.as_object() else {
        return Err("spec must be an object".into());
    };
    if let Some(key) = object.keys().find(|key| !SPEC_KEYS.contains(&key.as_str())) {
        return Err(format!("unknown key {key}"));
    }
    if object.get("tool").and_then(Value::as_str) != Some("relion") {
        return Err("tool must be \"relion\"".into());
    }
    let command = object.get("command").and_then(Value::as_str).unwrap_or("");
    let entry = command_definition(command)?;
    let project = object
        .get("project")
        .and_then(Value::as_str)
        .filter(|project| project_id(project))
        .ok_or("project must be a project id (32 lowercase hex digits)")?;
    let profile_given = match object.get("profile") {
        None => None,
        Some(Value::String(name)) if profile_name(name) => Some(name.clone()),
        Some(_) => return Err("profile must be a profile name".into()),
    };
    let options = validate_options(entry, object.get("options"))?;
    let inputs = validate_inputs(entry, object.get("inputs"), &options, parts)?;
    let context = Context {
        options: &options,
        inputs: &inputs,
        gpus: 0,
    };
    for rule in &entry.rules {
        if holds(Some(&rule.when), &context)? {
            return Err(rule.error.clone());
        }
    }
    if let Some((cpus, gpus)) = profile {
        relion_launch(command, cpus, gpus)?;
    }
    Ok(Validated {
        tool: "relion".into(),
        command: command.to_string(),
        project: project.to_string(),
        profile: profile_given,
        inputs,
        options,
    })
}

/// `relionLaunch`: ranks, threads and GPUs of a command on a profile.
pub fn relion_launch(command: &str, cpus: u32, gpus: u32) -> Result<Launch, String> {
    let launch = &command_definition(command)?.launch;
    if cpus < 1 {
        return Err("profile.cpus must be a positive integer".into());
    }
    let gpus = if launch.gpu { gpus } else { 0 };
    let mpi_ranks = match launch.rule {
        LaunchRule::Single => 1,
        LaunchRule::CpuRanks => (cpus / launch.threads_per_rank.unwrap_or(1).max(1)).max(1),
        LaunchRule::RefineRanks => {
            let needed = 3.max(gpus + 1);
            let ranks = if needed % 2 == 1 { needed } else { needed + 1 };
            if cpus < ranks {
                return Err(format!(
                    "{command} needs {ranks} MPI ranks with at least one CPU each; the profile has {cpus} CPUs"
                ));
            }
            ranks
        }
    };
    let threads = if launch.threads {
        (cpus / mpi_ranks).max(1)
    } else {
        1
    };
    Ok(Launch {
        mpi_ranks,
        threads,
        gpus,
    })
}

/// What placeholders expand to.
struct Expansion<'a> {
    command: &'a str,
    dir: &'a str,
    options: &'a Map<String, Value>,
    input_paths: &'a BTreeMap<String, String>,
    inputs: &'a BTreeMap<String, InputValue>,
    threads: u32,
}

fn derive(expansion: &Expansion<'_>, derived: &Derived) -> Result<String, String> {
    let options = expansion.options;
    let number = |name: &str| {
        options
            .get(name)
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    };
    let single = |name: &str| f64::from(number(name) as f32);
    Ok(match derived {
        Derived::Multiply { option, by } => relion_number(single(option) * by),
        Derived::EnumIndex { option } => {
            let definition = command_definition(expansion.command)?
                .options
                .get(option)
                .ok_or_else(|| format!("option {option} is not set"))?;
            let value = options.get(option).and_then(Value::as_str).unwrap_or("");
            let index = definition
                .choices
                .as_deref()
                .unwrap_or_default()
                .iter()
                .position(|choice| choice == value)
                .map_or(-1, |index| index as i64);
            index.to_string()
        }
        Derived::PowerSpectrumGrouping {
            dose,
            dose_per_frame,
        } => {
            let quotient = f64::from((single(dose) / single(dose_per_frame)) as f32);
            let grouping = round(quotient);
            js_number(if grouping == 0.0 { 1.0 } else { grouping })
        }
        Derived::ExtractBackgroundRadius {
            diameter,
            size,
            rescale,
            do_rescale,
        } => {
            let diameter = single(diameter);
            let size = single(size);
            let mut radius = if diameter < 0.0 {
                0.75 * size
            } else {
                diameter
            };
            radius /= 2.0;
            if options.get(do_rescale).and_then(Value::as_bool) == Some(true) {
                radius *= single(rescale);
                radius /= size;
            }
            relion_number(radius.trunc())
        }
    })
}

fn integer_text(value: &Value) -> String {
    js_number(value.as_f64().unwrap_or(f64::NAN))
}

fn format_option(
    expansion: &Expansion<'_>,
    name: &str,
    width: Option<usize>,
) -> Result<String, String> {
    let option = command_definition(expansion.command)?.options.get(name);
    let value = expansion.options.get(name);
    let (Some(option), Some(value)) = (option, value) else {
        return Err(format!("option {name} is not set"));
    };
    if let Some(width) = width {
        if option.kind != OptionKind::Int {
            return Err(format!("option {name} cannot be zero-padded"));
        }
        return Ok(format!("{:0>width$}", integer_text(value)));
    }
    match option.kind {
        OptionKind::Number => Ok(typed_number(value.as_f64().unwrap_or(f64::NAN))),
        OptionKind::Int => Ok(integer_text(value)),
        OptionKind::Enum | OptionKind::String => Ok(value.as_str().unwrap_or("").to_string()),
        kind => Err(format!(
            "option {name} of type {kind:?} cannot be written as an argument"
        )),
    }
}

fn placeholder() -> &'static Regex {
    static PLACEHOLDER: OnceLock<Regex> = OnceLock::new();
    PLACEHOLDER.get_or_init(|| {
        Regex::new(r"\{([A-Za-z]+)(?::([A-Za-z0-9]+))?(?::0([1-9]))?\}").expect("placeholder regex")
    })
}

fn expand(template: &str, expansion: &Expansion<'_>) -> Result<String, String> {
    let mut out = String::new();
    let mut last = 0;
    for captures in placeholder().captures_iter(template) {
        let whole = captures.get(0).expect("group 0");
        out.push_str(&template[last..whole.start()]);
        last = whole.end();
        let kind = &captures[1];
        let name = captures.get(2).map_or("", |name| name.as_str());
        let width = captures
            .get(3)
            .map(|width| width.as_str().parse::<usize>().unwrap_or(0));
        let text = match kind {
            "dir" => expansion.dir.to_string(),
            "threads" => expansion.threads.to_string(),
            "const" => definition()
                .constants
                .get(name)
                .cloned()
                .ok_or_else(|| format!("unknown constant {name}"))?,
            "option" => format_option(expansion, name, width)?,
            "derived" => {
                let derived = command_definition(expansion.command)?
                    .derived
                    .get(name)
                    .ok_or_else(|| format!("unsupported placeholder {}", whole.as_str()))?;
                derive(expansion, derived)?
            }
            "input" => expansion
                .input_paths
                .get(name)
                .cloned()
                .ok_or_else(|| format!("no path for input {name}"))?,
            "inputDir" | "inputPattern" => match expansion.inputs.get(name) {
                Some(InputValue::DataRoot {
                    root,
                    path,
                    pattern,
                }) => {
                    if kind == "inputPattern" {
                        pattern.clone()
                    } else {
                        ["/data", root, path]
                            .iter()
                            .filter(|part| !part.is_empty())
                            .copied()
                            .collect::<Vec<_>>()
                            .join("/")
                    }
                }
                _ => return Err(format!("input {name} is not a data-root reference")),
            },
            _ => return Err(format!("unsupported placeholder {}", whole.as_str())),
        };
        out.push_str(&text);
    }
    out.push_str(&template[last..]);
    Ok(out)
}

fn expand_args(
    items: &[Arg],
    expansion: &Expansion<'_>,
    context: &Context<'_>,
    out: &mut Vec<String>,
) -> Result<(), String> {
    for item in items {
        match item {
            Arg::Text(text) => out.push(expand(text, expansion)?),
            Arg::Group {
                when,
                args,
                otherwise,
            } => {
                if holds(when.as_ref(), context)? {
                    expand_args(args, expansion, context, out)?;
                } else if let Some(otherwise) = otherwise {
                    expand_args(otherwise, expansion, context, out)?;
                }
            }
        }
    }
    Ok(())
}

fn check_directory(command: &str, directory: &str) -> Result<(), String> {
    let job_type = job_type_directory(command)?;
    let number = directory
        .strip_prefix(job_type)
        .and_then(|rest| rest.strip_prefix("/job"));
    if !number
        .is_some_and(|digits| digits.len() >= 3 && digits.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(format!("directory must be {job_type}/jobNNN"));
    }
    Ok(())
}

/// `resolveInputPaths`: the inputs as the job sees them, in `/project`.
pub fn resolve_input_paths(validated: &Validated, directory: &str) -> BTreeMap<String, String> {
    validated
        .inputs
        .iter()
        .map(|(name, value)| {
            let path = match value {
                InputValue::Path(path) => path.clone(),
                InputValue::Part { part } => format!("{directory}/{part}.mrc"),
                InputValue::DataRoot {
                    root,
                    path,
                    pattern,
                } => ["/data", root, path, pattern]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("/"),
                InputValue::DataFile { root, path } => ["/data", root, path]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("/"),
            };
            (name.clone(), path)
        })
        .collect()
}

/// Inclusive runs of consecutive class numbers, ascending.
pub fn class_ranges(classes: &[i64]) -> Vec<(i64, i64)> {
    let mut sorted = classes.to_vec();
    sorted.sort_unstable();
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    for value in sorted {
        match ranges.last_mut() {
            Some(last) if value == last.1 + 1 => last.1 = value,
            _ => ranges.push((value, value)),
        }
    }
    ranges
}

fn select_classes_steps(
    validated: &Validated,
    dir: &str,
    input_paths: &BTreeMap<String, String>,
) -> Result<Vec<Program>, String> {
    let data = input_paths
        .get("particles")
        .ok_or("no path for input particles")?;
    let output = format!("{dir}particles.star");
    let ranges = class_ranges(&validated.ints("classes"));
    let select = |from: i64, to: i64, file: &str| -> Vec<String> {
        [
            "--i",
            data,
            "--o",
            file,
            "--select",
            "rlnClassNumber",
            "--minval",
            &from.to_string(),
            "--maxval",
            &to.to_string(),
        ]
        .iter()
        .map(|word| word.to_string())
        .collect()
    };
    let program = |args: Vec<String>| Program {
        program: "relion_star_handler".into(),
        args,
    };
    if let [(from, to)] = ranges.as_slice() {
        let mut args = select(*from, *to, &output);
        args.extend(["--pipeline_control".to_string(), dir.to_string()]);
        return Ok(vec![program(args)]);
    }
    let files: Vec<String> = ranges
        .iter()
        .map(|(from, to)| format!("{dir}classes_{from:03}_{to:03}.star"))
        .collect();
    let mut steps: Vec<Program> = ranges
        .iter()
        .zip(&files)
        .map(|((from, to), file)| program(select(*from, *to, file)))
        .collect();
    steps.push(program(vec![
        "--combine".into(),
        "--i".into(),
        files.join(" "),
        "--o".into(),
        output,
        "--pipeline_control".into(),
        dir.to_string(),
    ]));
    Ok(steps)
}

/// `relionCommand`: the command line of a validated spec in `directory`
/// (`Class2D/job006`) on a profile.
pub fn relion_command(
    validated: &Validated,
    directory: &str,
    cpus: u32,
    gpus: u32,
) -> Result<CommandLine, String> {
    let command = validated.command.as_str();
    let entry = command_definition(command)?;
    check_directory(command, directory)?;
    let launch = relion_launch(command, cpus, gpus)?;
    let dir = format!("{directory}/");
    let input_paths = resolve_input_paths(validated, directory);
    let expansion = Expansion {
        command,
        dir: &dir,
        options: &validated.options,
        input_paths: &input_paths,
        inputs: &validated.inputs,
        threads: launch.threads,
    };
    let context = Context {
        options: &validated.options,
        inputs: &validated.inputs,
        gpus: launch.gpus,
    };
    let mut steps: Vec<Program> = Vec::new();
    for step in &entry.steps {
        if !holds(step.when.as_ref(), &context)? {
            continue;
        }
        match step.builder.as_deref() {
            Some("selectClasses") => {
                steps.extend(select_classes_steps(validated, &dir, &input_paths)?);
                continue;
            }
            Some(builder) => return Err(format!("unsupported step builder {builder}")),
            None => {}
        }
        let first = steps.is_empty();
        if first && launch.mpi_ranks > 1 && !step.mpi {
            return Err(format!(
                "{command} has {} ranks but its program is not MPI",
                launch.mpi_ranks
            ));
        }
        let program = step.program.as_deref().ok_or("a step has no program")?;
        let program = if first && step.mpi && launch.mpi_ranks > 1 {
            format!("{program}_mpi")
        } else {
            program.to_string()
        };
        let mut args = Vec::new();
        expand_args(&step.args, &expansion, &context, &mut args)?;
        steps.push(Program { program, args });
    }
    let mut steps = steps.into_iter();
    let first = steps.next().ok_or("the command has no step")?;
    Ok(CommandLine {
        program: first.program,
        args: first.args,
        launch,
        then: steps.collect(),
    })
}

/// `relionOutputs`: files a successful job writes, relative to its directory.
pub fn relion_outputs(validated: &Validated) -> Result<Vec<(String, bool)>, String> {
    let entry = validated.entry();
    let no_paths = BTreeMap::new();
    let expansion = Expansion {
        command: &validated.command,
        dir: "",
        options: &validated.options,
        input_paths: &no_paths,
        inputs: &validated.inputs,
        threads: 1,
    };
    let context = Context {
        options: &validated.options,
        inputs: &validated.inputs,
        gpus: 0,
    };
    let mut outputs = Vec::new();
    for output in &entry.outputs {
        if holds(output.when.as_ref(), &context)? {
            outputs.push((expand(&output.path, &expansion)?, output.required));
        }
    }
    Ok(outputs)
}

fn contains_word(line: &str, word: &str) -> bool {
    let is_word = |character: Option<char>| {
        character.is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
    };
    line.match_indices(word).any(|(start, _)| {
        !is_word(line[..start].chars().next_back())
            && !is_word(line[start + word.len()..].chars().next())
    })
}

/// The level of a log line: `ERROR`, else `WARNING` or `Warning`, as words.
pub fn line_level(line: &str) -> LogLevel {
    if contains_word(line, "ERROR") {
        LogLevel::Error
    } else if contains_word(line, "WARNING") || contains_word(line, "Warning") {
        LogLevel::Warning
    } else {
        LogLevel::Info
    }
}

fn line_progress(command: &Command, line: &str) -> Option<(f64, String)> {
    static BAR: OnceLock<Regex> = OnceLock::new();
    static ITERATION: OnceLock<Regex> = OnceLock::new();
    static AUTO_REFINE: OnceLock<Regex> = OnceLock::new();
    let progress = command.progress.as_ref()?;
    match progress.kind {
        ProgressKind::Bar => {
            let bar = BAR.get_or_init(|| {
                Regex::new(r#"([0-9]+(?:\.[0-9]+)?)/\s*([0-9]+(?:\.[0-9]+)?) (?:sec|min|hrs) (\.*)~~\(,_,">"#)
                    .expect("bar regex")
            });
            line.split('\r').rev().find_map(|segment| {
                bar.captures(segment).map(|captures| {
                    let dots = captures[3].len() as f64;
                    ((dots / 60.0).min(1.0), progress.stage.clone())
                })
            })
        }
        ProgressKind::Iterations => {
            let iteration = ITERATION.get_or_init(|| {
                Regex::new(r"(?:Gradient optimisation|Expectation) iteration ([0-9]+) of ([0-9]+)")
                    .expect("iteration regex")
            });
            let captures = iteration.captures(line)?;
            let current: f64 = captures[1].parse().ok()?;
            let total: f64 = captures[2].parse().ok()?;
            if total < 1.0 {
                return None;
            }
            Some((
                ((current - 1.0) / total).min(1.0),
                format!(
                    "{}: iteration {} of {}",
                    progress.stage,
                    js_number(current),
                    js_number(total)
                ),
            ))
        }
        ProgressKind::AutoRefine => {
            if line.contains("Auto-refine: Refinement has converged") {
                return Some((0.9, format!("{}: final iteration", progress.stage)));
            }
            let auto_refine = AUTO_REFINE.get_or_init(|| {
                Regex::new(r"Auto-refine: Iteration= ([0-9]+)").expect("auto-refine regex")
            });
            let current: f64 = auto_refine.captures(line)?[1].parse().ok()?;
            Some((
                (current / 25.0).min(0.9),
                format!("{}: iteration {}", progress.stage, js_number(current)),
            ))
        }
    }
}

/// `parseRelionLogLine`: the level and progress of one output line.
pub fn parse_relion_log_line(command: &str, line: &str) -> (LogLevel, Option<(f64, String)>) {
    let progress = command_definition(command)
        .ok()
        .and_then(|entry| line_progress(entry, line));
    (line_level(line), progress)
}

#[cfg(test)]
#[path = "spec_tests.rs"]
mod tests;
