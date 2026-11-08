//! `packages/cryo-em/src/commands.json`, the relion tool's command table,
//! parsed into types. `packages/cryo-em/README.md` is its schema. Maps keep
//! the file's order, because validation reports the first problem in that
//! order, as `spec.js` does.

use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;
use std::sync::OnceLock;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// The table, embedded at build time.
pub const COMMANDS_JSON: &str = include_str!("../../../../../packages/cryo-em/src/commands.json");

/// The parsed table.
pub fn definition() -> &'static Definition {
    static DEFINITION: OnceLock<Definition> = OnceLock::new();
    DEFINITION.get_or_init(|| {
        serde_json::from_str(COMMANDS_JSON).expect("packages/cryo-em/src/commands.json parses")
    })
}

/// A JSON object whose entries keep their order in the file.
#[derive(Debug, Clone)]
pub struct Ordered<T>(pub Vec<(String, T)>);

impl<T> Ordered<T> {
    /// The value under `key`.
    pub fn get(&self, key: &str) -> Option<&T> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// Entries in file order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &T)> {
        self.0.iter().map(|(name, value)| (name.as_str(), value))
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Ordered<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for OrderedVisitor<T> {
            type Value = Ordered<T>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Ordered<T>, M::Error> {
                let mut entries = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, T>()? {
                    entries.push((key, value));
                }
                Ok(Ordered(entries))
            }
        }
        deserializer.deserialize_map(OrderedVisitor(PhantomData))
    }
}

/// The whole table.
#[derive(Debug, Deserialize)]
pub struct Definition {
    /// `relion`.
    pub tool: String,
    /// RELION's version, `5.1.1`.
    pub version: String,
    /// Fixed values for `{const:NAME}`.
    pub constants: BTreeMap<String, String>,
    /// Commands in the order the protocol lists them.
    pub commands: Ordered<Command>,
}

/// One command.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    /// RELION job directory type (`Class2D`).
    pub job_type: String,
    /// How the command uses a profile.
    pub launch: Launch,
    /// Inputs in file order.
    pub inputs: Ordered<Input>,
    /// Options in file order.
    pub options: Ordered<OptionDef>,
    /// Refusals across options and inputs.
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Values computed from options.
    #[serde(default)]
    pub derived: BTreeMap<String, Derived>,
    /// The main program, then follow-up steps.
    pub steps: Vec<Step>,
    /// Files the job writes.
    pub outputs: Vec<Output>,
    /// How log lines report progress.
    pub progress: Option<Progress>,
}

/// `launch`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    /// The rank rule.
    pub rule: LaunchRule,
    /// Threads of one rank for `cpuRanks`.
    #[serde(default)]
    pub threads_per_rank: Option<u32>,
    /// Whether `--j` is passed.
    pub threads: bool,
    /// Whether the command uses the profile's GPUs.
    pub gpu: bool,
}

/// `launch.rule`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchRule {
    /// One process.
    Single,
    /// `max(1, floor(cpus / threadsPerRank))` ranks.
    CpuRanks,
    /// The smallest odd rank count of at least `max(3, gpus + 1)`.
    RefineRanks,
}

/// What an input accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Accept {
    /// A project-relative file of an earlier job.
    Path,
    /// An uploaded MRC part.
    Part,
    /// `{ root, path, pattern }`.
    DataRoot,
    /// `{ root, path }`.
    DataFile,
}

impl Accept {
    /// The form named in error messages.
    pub fn describe(self, name: &str) -> String {
        match self {
            Accept::Path => "a project-relative path".to_string(),
            Accept::Part => format!("{{ \"part\": \"{name}\" }}"),
            Accept::DataRoot => "{ root, path, pattern }".to_string(),
            Accept::DataFile => "{ root, path }".to_string(),
        }
    }
}

/// `inputs.<name>`.
#[derive(Debug, Deserialize)]
pub struct Input {
    /// Accepted forms.
    pub accept: Vec<Accept>,
    /// Job types a path may come from.
    #[serde(default)]
    pub from: Vec<String>,
    /// Required ending of a path.
    #[serde(default)]
    pub suffix: Option<String>,
    /// A regular expression the path must contain.
    #[serde(default)]
    pub pattern: Option<String>,
    /// Whether the input may be left out.
    #[serde(default)]
    pub optional: bool,
    /// When the input applies.
    #[serde(default)]
    pub when: Option<Condition>,
}

/// `options.<name>.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum OptionKind {
    /// A boolean.
    #[serde(rename = "bool")]
    Bool,
    /// An integer.
    #[serde(rename = "int")]
    Int,
    /// A finite number.
    #[serde(rename = "number")]
    Number,
    /// One of `enum`.
    #[serde(rename = "enum")]
    Enum,
    /// A string matching `pattern`.
    #[serde(rename = "string")]
    String,
    /// Distinct integers.
    #[serde(rename = "int-list")]
    IntList,
}

/// `options.<name>`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionDef {
    /// RELION's job option variable.
    #[serde(default)]
    pub gui: Option<String>,
    /// The value type.
    #[serde(rename = "type")]
    pub kind: OptionKind,
    /// The GUI default.
    #[serde(default)]
    pub default: Option<Value>,
    /// Whether the option has no default.
    #[serde(default)]
    pub required: bool,
    /// Inclusive minimum (of each item for `int-list`).
    #[serde(default)]
    pub min: Option<serde_json::Number>,
    /// Inclusive maximum.
    #[serde(default)]
    pub max: Option<serde_json::Number>,
    /// The value must be a multiple of this.
    #[serde(default)]
    pub multiple_of: Option<serde_json::Number>,
    /// Allowed values of an `enum`.
    #[serde(default, rename = "enum")]
    pub choices: Option<Vec<String>>,
    /// Regular expression of a `string`.
    #[serde(default)]
    pub pattern: Option<String>,
    /// Item count limits of an `int-list`.
    #[serde(default)]
    pub min_items: Option<usize>,
    /// Item count limits of an `int-list`.
    #[serde(default)]
    pub max_items: Option<usize>,
    /// When the option applies.
    #[serde(default)]
    pub when: Option<Condition>,
}

/// `rules[]`.
#[derive(Debug, Deserialize)]
pub struct Rule {
    /// The spec is refused when this holds.
    pub when: Condition,
    /// The refusal.
    pub error: String,
}

/// `derived.<name>`.
#[derive(Debug, Deserialize)]
#[serde(tag = "fn", rename_all = "camelCase")]
pub enum Derived {
    /// `floatToString(float(option) * by)`.
    Multiply {
        /// The option.
        option: String,
        /// The factor.
        by: f64,
    },
    /// The option's index in its `enum`.
    EnumIndex {
        /// The option.
        option: String,
    },
    /// MotionCorr's `--grouping_for_ps`.
    #[serde(rename_all = "camelCase")]
    PowerSpectrumGrouping {
        /// The dose option.
        dose: String,
        /// The dose per frame option.
        dose_per_frame: String,
    },
    /// Extract's `--bg_radius`.
    #[serde(rename_all = "camelCase")]
    ExtractBackgroundRadius {
        /// The background diameter option.
        diameter: String,
        /// The box size option.
        size: String,
        /// The rescaled size option.
        rescale: String,
        /// The rescale switch.
        do_rescale: String,
    },
}

/// `steps[]`.
#[derive(Debug, Deserialize)]
pub struct Step {
    /// When the step runs.
    #[serde(default)]
    pub when: Option<Condition>,
    /// The program.
    #[serde(default)]
    pub program: Option<String>,
    /// Its arguments.
    #[serde(default)]
    pub args: Vec<Arg>,
    /// Append `_mpi` with more than one rank.
    #[serde(default)]
    pub mpi: bool,
    /// A step sequence written in code (`selectClasses`).
    #[serde(default)]
    pub builder: Option<String>,
}

/// An argument template.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Arg {
    /// A string with placeholders.
    Text(String),
    /// `{ when, args, else }`.
    Group {
        /// The condition.
        #[serde(default)]
        when: Option<Condition>,
        /// Emitted when it holds.
        args: Vec<Arg>,
        /// Emitted otherwise.
        #[serde(default, rename = "else")]
        otherwise: Option<Vec<Arg>>,
    },
}

/// `outputs[]`.
#[derive(Debug, Deserialize)]
pub struct Output {
    /// Template relative to the job directory.
    pub path: String,
    /// Whether success requires it.
    pub required: bool,
    /// When it is written.
    #[serde(default)]
    pub when: Option<Condition>,
}

/// `progress`.
#[derive(Debug, Deserialize)]
pub struct Progress {
    /// Which lines report progress.
    pub kind: ProgressKind,
    /// The stage name.
    pub stage: String,
}

/// `progress.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressKind {
    /// RELION's progress bar.
    Bar,
    /// `Gradient optimisation iteration N of M`.
    Iterations,
    /// `Auto-refine: Iteration= N`.
    AutoRefine,
}

/// A comparison of an option with a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparison {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    In,
    NotIn,
}

/// A condition (README "Conditions").
#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    /// Every item holds.
    All(Vec<Condition>),
    /// The item does not hold.
    Not(Box<Condition>),
    /// The launch has (`true`) or lacks (`false`) GPUs.
    Gpus(bool),
    /// The input was given (`present: true`) or not.
    Input { name: String, present: bool },
    /// The option compares so with `value`.
    Option {
        name: String,
        comparison: Comparison,
        value: Value,
    },
}

impl<'de> Deserialize<'de> for Condition {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Condition::parse(&value).map_err(de::Error::custom)
    }
}

impl Condition {
    fn parse(value: &Value) -> Result<Condition, String> {
        let object = value
            .as_object()
            .ok_or_else(|| format!("condition {value} is not an object"))?;
        if let Some(all) = object.get("all") {
            let items = all.as_array().ok_or("all must be a list")?;
            return items
                .iter()
                .map(Condition::parse)
                .collect::<Result<_, _>>()
                .map(Condition::All);
        }
        if let Some(inner) = object.get("not") {
            return Ok(Condition::Not(Box::new(Condition::parse(inner)?)));
        }
        if let Some(gpus) = object.get("gpus") {
            return gpus
                .as_bool()
                .map(Condition::Gpus)
                .ok_or_else(|| "gpus must be a boolean".to_string());
        }
        if let Some(input) = object.get("input") {
            return Ok(Condition::Input {
                name: input.as_str().ok_or("input must be a string")?.to_string(),
                present: object
                    .get("present")
                    .and_then(Value::as_bool)
                    .ok_or("present must be a boolean")?,
            });
        }
        let name = object
            .get("option")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("unsupported condition {value}"))?
            .to_string();
        let comparisons = [
            ("eq", Comparison::Eq),
            ("ne", Comparison::Ne),
            ("gt", Comparison::Gt),
            ("ge", Comparison::Ge),
            ("lt", Comparison::Lt),
            ("le", Comparison::Le),
            ("in", Comparison::In),
            ("notIn", Comparison::NotIn),
        ];
        for (key, comparison) in comparisons {
            if let Some(operand) = object.get(key) {
                if matches!(comparison, Comparison::In | Comparison::NotIn) && !operand.is_array() {
                    return Err(format!("{key} must be a list"));
                }
                return Ok(Condition::Option {
                    name,
                    comparison,
                    value: operand.clone(),
                });
            }
        }
        Err(format!("unsupported condition {value}"))
    }

    /// The condition as the table writes it, in its key order.
    pub fn to_json(&self) -> String {
        match self {
            Condition::All(items) => format!(
                "{{\"all\":[{}]}}",
                items
                    .iter()
                    .map(Condition::to_json)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Condition::Not(inner) => format!("{{\"not\":{}}}", inner.to_json()),
            Condition::Gpus(gpus) => format!("{{\"gpus\":{gpus}}}"),
            Condition::Input { name, present } => {
                format!(
                    "{{\"input\":{},\"present\":{present}}}",
                    Value::from(name.as_str())
                )
            }
            Condition::Option {
                name,
                comparison,
                value,
            } => {
                let key = match comparison {
                    Comparison::Eq => "eq",
                    Comparison::Ne => "ne",
                    Comparison::Gt => "gt",
                    Comparison::Ge => "ge",
                    Comparison::Lt => "lt",
                    Comparison::Le => "le",
                    Comparison::In => "in",
                    Comparison::NotIn => "notIn",
                };
                format!(
                    "{{\"option\":{},\"{key}\":{value}}}",
                    Value::from(name.as_str())
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_in_file_order() {
        let definition = definition();
        assert_eq!(definition.tool, "relion");
        let commands: Vec<&str> = definition.commands.iter().map(|(name, _)| name).collect();
        assert_eq!(
            commands,
            [
                "import",
                "motioncorr",
                "ctffind",
                "autopick",
                "extract",
                "class2d",
                "select",
                "initialmodel",
                "refine3d",
                "maskcreate",
                "postprocess"
            ]
        );
        let import = definition.commands.get("import").unwrap();
        assert_eq!(import.options.0[0].0, "isMultiframe");
        assert_eq!(import.job_type, "Import");
    }

    #[test]
    fn conditions_serialise_in_table_order() {
        let condition: Condition = serde_json::from_str(
            r#"{"all":[{"option":"doRunC1","eq":true},{"option":"sym","notIn":["C1","c1"]}]}"#,
        )
        .unwrap();
        assert_eq!(
            condition.to_json(),
            r#"{"all":[{"option":"doRunC1","eq":true},{"option":"sym","notIn":["C1","c1"]}]}"#
        );
    }
}
