//! STAR files as RELION 5 writes them, and a reader of the subset RELION
//! writes (`parseStar` of `test-utils/relion-simulator.mjs`).

use super::spec::relion_number;

/// The line before every block.
pub const STAR_VERSION: &str = "# version 50001";

/// One value: numbers are written as RELION writes them.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    /// Written with `relion_number`.
    Num(f64),
    /// Written as is, quoted when empty or containing whitespace.
    Text(String),
}

impl Cell {
    /// The value as a number (JavaScript `Number`).
    pub fn number(&self) -> f64 {
        match self {
            Cell::Num(value) => *value,
            Cell::Text(text) => parse_number(text),
        }
    }

    fn formatted(&self) -> String {
        let text = match self {
            Cell::Num(value) => relion_number(*value),
            Cell::Text(text) => text.clone(),
        };
        if text.is_empty() {
            "\"\"".into()
        } else if text.chars().any(char::is_whitespace) {
            format!("\"{text}\"")
        } else {
            text
        }
    }
}

impl From<f64> for Cell {
    fn from(value: f64) -> Cell {
        Cell::Num(value)
    }
}

impl From<&str> for Cell {
    fn from(value: &str) -> Cell {
        Cell::Text(value.to_string())
    }
}

impl From<String> for Cell {
    fn from(value: String) -> Cell {
        Cell::Text(value)
    }
}

/// JavaScript's `Number(text)` for the values STAR files hold.
pub fn parse_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse().unwrap_or(f64::NAN)
}

/// A loop: labels without the leading underscore, and rows.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

impl Table {
    /// A loop block.
    pub fn new(name: &str, columns: &[&str], rows: Vec<Vec<Cell>>) -> Table {
        Table {
            name: name.to_string(),
            columns: columns.iter().map(|column| column.to_string()).collect(),
            rows,
        }
    }

    /// The column of `label`.
    pub fn index(&self, label: &str) -> Result<usize, String> {
        self.columns
            .iter()
            .position(|column| column == label)
            .ok_or_else(|| format!("data_{} has no {label} column", self.name))
    }

    /// The value of `label` in `row`.
    pub fn cell<'a>(&self, row: &'a [Cell], label: &str) -> Result<&'a Cell, String> {
        let index = self.index(label)?;
        row.get(index)
            .ok_or_else(|| format!("a row of data_{} lacks {label}", self.name))
    }

    /// The text of `label` in `row`.
    pub fn text(&self, row: &[Cell], label: &str) -> Result<String, String> {
        Ok(match self.cell(row, label)? {
            Cell::Text(text) => text.clone(),
            Cell::Num(value) => relion_number(*value),
        })
    }

    /// The table with columns set from `entries`: an existing column of the
    /// same label is replaced, a new one appended. Each value is computed
    /// from the original row and its index.
    pub fn with_columns(&self, name: &str, entries: Vec<ColumnValue<'_>>) -> Table {
        let mut columns = self.columns.clone();
        let mut rows = self.rows.clone();
        for (label, value_of) in entries {
            let index = match columns.iter().position(|column| column == label) {
                Some(index) => index,
                None => {
                    columns.push(label.to_string());
                    columns.len() - 1
                }
            };
            for (row_index, row) in rows.iter_mut().enumerate() {
                let value = value_of(&self.rows[row_index], row_index);
                if index < row.len() {
                    row[index] = value;
                } else {
                    row.resize(index, Cell::Text(String::new()));
                    row.push(value);
                }
            }
        }
        Table {
            name: name.to_string(),
            columns,
            rows,
        }
    }

    /// The same table under another name.
    pub fn renamed(&self, name: &str) -> Table {
        Table {
            name: name.to_string(),
            ..self.clone()
        }
    }
}

/// A column label and how each row's value is computed.
pub type ColumnValue<'a> = (&'a str, Box<dyn Fn(&[Cell], usize) -> Cell + 'a>);

/// A block to write.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    /// A loop.
    Loop(Table),
    /// Key-value pairs.
    Pairs(String, Vec<(String, Cell)>),
}

/// A key-value block.
pub fn pairs(name: &str, pairs: Vec<(&str, Cell)>) -> Block {
    Block::Pairs(
        name.to_string(),
        pairs
            .into_iter()
            .map(|(label, value)| (label.to_string(), value))
            .collect(),
    )
}

/// STAR text as RELION 5 writes it.
pub fn format_star(blocks: &[Block]) -> String {
    let mut text = String::new();
    for block in blocks {
        let name = match block {
            Block::Loop(table) => &table.name,
            Block::Pairs(name, _) => name,
        };
        text.push_str(&format!("\n{STAR_VERSION}\n\ndata_{name}\n\n"));
        match block {
            Block::Pairs(_, pairs) => {
                let width = pairs
                    .iter()
                    .map(|(label, _)| label.len())
                    .max()
                    .unwrap_or(0)
                    + 2;
                for (label, value) in pairs {
                    text.push_str(&format!("_{label:<width$}{}\n", value.formatted()));
                }
            }
            Block::Loop(table) => {
                text.push_str("loop_\n");
                for (index, label) in table.columns.iter().enumerate() {
                    text.push_str(&format!("_{label} #{}\n", index + 1));
                }
                for row in &table.rows {
                    let cells: Vec<String> = row.iter().map(Cell::formatted).collect();
                    text.push_str(&cells.join(" "));
                    text.push('\n');
                }
            }
        }
        text.push('\n');
    }
    text
}

/// A parsed block: pairs for key-value blocks, columns and rows for a loop.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub name: String,
    pub pairs: Vec<(String, String)>,
    pub table: Table,
}

impl Parsed {
    /// The value of a key-value pair.
    pub fn pair(&self, label: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(key, _)| key == label)
            .map(|(_, value)| value.as_str())
    }
}

// Words of a line: "double" or 'single' quoted, or runs of non-space.
fn tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    loop {
        rest = rest.trim_start();
        let Some(first) = rest.chars().next() else {
            return out;
        };
        if first == '"' || first == '\'' {
            if let Some(end) = rest[1..].find(first) {
                out.push(rest[1..1 + end].to_string());
                rest = &rest[end + 2..];
                continue;
            }
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        out.push(rest[..end].to_string());
        rest = &rest[end..];
    }
}

/// Parses STAR text into blocks. Values stay strings.
pub fn parse_star(text: &str) -> Result<Vec<Parsed>, String> {
    let mut blocks: Vec<Parsed> = Vec::new();
    let mut in_loop = false;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix("data_") {
            blocks.push(Parsed {
                name: name.to_string(),
                table: Table {
                    name: name.to_string(),
                    ..Table::default()
                },
                ..Parsed::default()
            });
            in_loop = false;
            continue;
        }
        let Some(block) = blocks.last_mut() else {
            return Err("STAR text has content before its first data_ block".into());
        };
        if line == "loop_" || line.starts_with("loop_ ") {
            in_loop = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix('_') {
            let words = tokens(rest);
            let label = words.first().cloned().unwrap_or_default();
            if in_loop && block.table.rows.is_empty() {
                block.table.columns.push(label);
            } else {
                let value = words.get(1).cloned().unwrap_or_default();
                match block.pairs.iter_mut().find(|(key, _)| *key == label) {
                    Some(pair) => pair.1 = value,
                    None => block.pairs.push((label, value)),
                }
            }
            continue;
        }
        if !in_loop {
            return Err(format!(
                "unexpected STAR line in data_{}: {line}",
                block.name
            ));
        }
        let row = tokens(line);
        if row.len() != block.table.columns.len() {
            return Err(format!(
                "a row of data_{} has {} values for {} columns",
                block.name,
                row.len(),
                block.table.columns.len()
            ));
        }
        block
            .table
            .rows
            .push(row.into_iter().map(Cell::Text).collect());
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_blocks() {
        let text = format_star(&[
            pairs(
                "general",
                vec![
                    ("rlnImageSizeX", Cell::Num(64.0)),
                    ("rlnMicrographMovieName", "a b".into()),
                ],
            ),
            Block::Loop(Table::new(
                "",
                &["rlnCoordinateX", "rlnAnglePsi"],
                vec![
                    vec![Cell::Num(16.0), Cell::Num(-999.0)],
                    vec![Cell::Num(0.885), "".into()],
                ],
            )),
        ]);
        assert!(
            text.starts_with("\n# version 50001\n\ndata_general\n\n_rlnImageSizeX           64\n")
        );
        assert!(text.contains("loop_\n_rlnCoordinateX #1\n_rlnAnglePsi #2\n16 -999\n0.885 \"\"\n"));
        let blocks = parse_star(&text).unwrap();
        assert_eq!(blocks[0].pair("rlnMicrographMovieName"), Some("a b"));
        assert_eq!(blocks[1].name, "");
        assert_eq!(
            blocks[1].table.rows[1],
            vec![Cell::Text("0.885".into()), Cell::Text(String::new())]
        );
    }

    #[test]
    fn refuses_malformed_text() {
        assert!(parse_star("_rlnX 1\n").is_err());
        assert!(parse_star("data_x\nloop_\n_rlnA #1\n1 2\n").is_err());
        assert!(parse_star("data_x\n1 2\n").is_err());
    }
}
