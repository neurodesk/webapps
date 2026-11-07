//! Operator-named read-only data roots, the relative-path rules shared with
//! projects, directory listings and file-name patterns.
//!
//! These checks give early errors and protect the listing endpoint. The
//! security boundary of a job is its container's mount set.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Maximum entries of one listing page.
pub const PAGE_SIZE: usize = 1000;

/// Maximum length of a relative path in bytes.
pub const MAX_PATH_BYTES: usize = 1024;

/// Maximum length of a pattern in bytes.
pub const MAX_PATTERN_BYTES: usize = 255;

/// A named read-only directory (`--data-root facility=/scratch/cryoem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRoot {
    /// Identifier matching `^[a-z0-9][a-z0-9-]{0,31}$`; also its label.
    pub id: String,
    /// Canonical host path.
    pub path: PathBuf,
}

impl DataRoot {
    /// Parses `id=/absolute/path` and canonicalises the path.
    pub fn parse(argument: &str) -> Result<DataRoot, String> {
        let (id, path) = argument
            .split_once('=')
            .ok_or_else(|| format!("--data-root '{argument}' is not id=/path"))?;
        if !valid_root_id(id) {
            return Err(format!(
                "data root id '{id}' must match ^[a-z0-9][a-z0-9-]{{0,31}}$"
            ));
        }
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err(format!("data root '{id}' must be an absolute path"));
        }
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("data root '{id}' ({}): {error}", path.display()))?;
        if !canonical.is_dir() {
            return Err(format!("data root '{id}' is not a directory"));
        }
        Ok(DataRoot {
            id: id.to_string(),
            path: canonical,
        })
    }

    /// Where jobs see the root: `/data/<id>`, read-only.
    pub fn container_path(&self) -> String {
        format!("/data/{}", self.id)
    }
}

/// Whether `id` is a valid data root identifier.
pub fn valid_root_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    let lower_alnum = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    bytes.len() <= 32
        && lower_alnum(first)
        && bytes[1..]
            .iter()
            .all(|byte| lower_alnum(byte) || *byte == b'-')
}

/// Why a path was refused.
#[derive(Debug)]
pub enum PathError {
    /// The text breaks the relative-path or pattern rules.
    Invalid(String),
    /// The path does not exist or cannot be read.
    Missing,
    /// The canonical path lies outside the canonical base.
    Outside,
    /// The pattern matched no file.
    NoMatch,
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathError::Invalid(message) => f.write_str(message),
            PathError::Missing => f.write_str("no such file or directory"),
            PathError::Outside => f.write_str("path lies outside its root"),
            PathError::NoMatch => f.write_str("the pattern matches no file"),
        }
    }
}

/// A client-supplied path relative to a data root or a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelativePath(String);

impl RelativePath {
    /// Applies the protocol's rules: at most 1024 bytes, `/`-separated, no
    /// empty, `.` or `..` component, no leading `/`, no `\`, no NUL. The empty
    /// string is the base itself.
    pub fn parse(text: &str) -> Result<RelativePath, PathError> {
        let invalid = |reason: &str| Err(PathError::Invalid(format!("path '{text}' {reason}")));
        if text.len() > MAX_PATH_BYTES {
            return invalid("is longer than 1024 bytes");
        }
        if text.contains('\0') {
            return invalid("contains NUL");
        }
        if text.contains('\\') {
            return invalid("contains a backslash");
        }
        if text.is_empty() {
            return Ok(RelativePath(String::new()));
        }
        if text.starts_with('/') {
            return invalid("is absolute");
        }
        for component in text.split('/') {
            if component.is_empty() || component == "." || component == ".." {
                return invalid("has an empty, '.' or '..' component");
            }
        }
        Ok(RelativePath(text.to_string()))
    }

    /// The path text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The final component, or the empty string for the base itself.
    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or("")
    }

    /// Joins the path onto `base`, canonicalises the result and requires it to
    /// lie inside `base`, which must itself be canonical.
    pub fn resolve(&self, base: &Path) -> Result<PathBuf, PathError> {
        let joined = if self.0.is_empty() {
            base.to_path_buf()
        } else {
            base.join(&self.0)
        };
        let canonical = joined.canonicalize().map_err(|_| PathError::Missing)?;
        if canonical.starts_with(base) {
            Ok(canonical)
        } else {
            Err(PathError::Outside)
        }
    }
}

/// `relative` of a canonical path inside canonical `base`, `/`-separated.
pub fn relative_to(base: &Path, path: &Path) -> Result<String, PathError> {
    let relative = path.strip_prefix(base).map_err(|_| PathError::Outside)?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let part = component
            .as_os_str()
            .to_str()
            .ok_or_else(|| PathError::Invalid("path is not UTF-8".into()))?;
        parts.push(part);
    }
    Ok(parts.join("/"))
}

/// Kind of a listed entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// A regular file.
    File,
    /// A directory.
    Directory,
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedEntry {
    /// File name.
    pub name: String,
    /// File or directory (a symlink is listed with its target's kind).
    pub kind: EntryKind,
    /// Size of a file, `null` for directories.
    pub bytes: Option<u64>,
    /// RFC 3339 modification time.
    pub modified_at: Option<String>,
}

/// One page of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Page {
    /// The requested relative path.
    pub path: String,
    /// Entries sorted by name in byte order.
    pub entries: Vec<ListedEntry>,
    /// Opaque cursor of the following page.
    pub next: Option<String>,
}

/// Lists one directory level of a root. Every error means "not found" to the
/// caller, so a listing never tells a missing path from one outside the root.
pub fn list(root: &DataRoot, path: &str, cursor: Option<&str>) -> Result<Page, PathError> {
    let relative = RelativePath::parse(path)?;
    let directory = relative.resolve(&root.path)?;
    let after = match cursor {
        Some(cursor) => Some(decode_cursor(cursor).ok_or(PathError::Missing)?),
        None => None,
    };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|_| PathError::Missing)? {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = visible_name(&entry) else {
            continue;
        };
        if after.as_deref().is_some_and(|after| name.as_str() <= after) {
            continue;
        }
        let Some(metadata) = contained_metadata(&root.path, &entry) else {
            continue;
        };
        let kind = if metadata.is_file() {
            EntryKind::File
        } else if metadata.is_dir() {
            EntryKind::Directory
        } else {
            continue;
        };
        entries.push(ListedEntry {
            name,
            kind,
            bytes: (kind == EntryKind::File).then_some(metadata.len()),
            modified_at: metadata.modified().ok().map(rfc3339),
        });
    }
    entries.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    let next = if entries.len() > PAGE_SIZE {
        entries.truncate(PAGE_SIZE);
        entries.last().map(|entry| encode_cursor(&entry.name))
    } else {
        None
    };
    Ok(Page {
        path: relative.as_str().to_string(),
        entries,
        next,
    })
}

/// Files of one directory of a root that a pattern selects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternMatch {
    /// Canonical directory, relative to the root.
    pub directory: String,
    /// Matching file names, sorted.
    pub names: Vec<String>,
}

/// Resolves `{ root, path, pattern }`. Every match is canonicalised and must
/// lie inside the root; a match outside it refuses the whole reference.
pub fn match_pattern(
    root: &DataRoot,
    path: &str,
    pattern: &str,
) -> Result<PatternMatch, PathError> {
    validate_pattern(pattern)?;
    let directory = RelativePath::parse(path)?.resolve(&root.path)?;
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|_| PathError::Missing)? {
        let entry = entry.map_err(|_| PathError::Missing)?;
        let Some(name) = visible_name(&entry) else {
            continue;
        };
        if !glob_matches(pattern, &name) {
            continue;
        }
        let canonical = entry
            .path()
            .canonicalize()
            .map_err(|_| PathError::Missing)?;
        if !canonical.starts_with(&root.path) {
            return Err(PathError::Outside);
        }
        if canonical.is_file() {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Err(PathError::NoMatch);
    }
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(PatternMatch {
        directory: relative_to(&root.path, &directory)?,
        names,
    })
}

/// A pattern is 1 to 255 bytes, has no `/` and no NUL.
pub fn validate_pattern(pattern: &str) -> Result<(), PathError> {
    if pattern.is_empty() || pattern.len() > MAX_PATTERN_BYTES {
        return Err(PathError::Invalid("pattern must be 1 to 255 bytes".into()));
    }
    if pattern.contains('/') || pattern.contains('\0') {
        return Err(PathError::Invalid(
            "pattern must not contain '/' or NUL".into(),
        ));
    }
    Ok(())
}

/// Matches `*` (any run of characters) and `?` (one character); every other
/// character matches itself.
pub fn glob_matches(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    let mut p = 0;
    let mut n = 0;
    let mut star: Option<(usize, usize)> = None;
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, n));
            p += 1;
        } else if let Some((star_p, star_n)) = star {
            p = star_p + 1;
            n = star_n + 1;
            star = Some((star_p, star_n + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

fn visible_name(entry: &std::fs::DirEntry) -> Option<String> {
    let name = entry.file_name().into_string().ok()?;
    if name.starts_with('.') {
        None
    } else {
        Some(name)
    }
}

/// Metadata of an entry, following a symlink only when its target lies inside `base`.
fn contained_metadata(base: &Path, entry: &std::fs::DirEntry) -> Option<std::fs::Metadata> {
    let file_type = entry.file_type().ok()?;
    if !file_type.is_symlink() {
        return entry.metadata().ok();
    }
    let target = entry.path().canonicalize().ok()?;
    if !target.starts_with(base) {
        return None;
    }
    std::fs::metadata(target).ok()
}

/// RFC 3339 UTC seconds.
pub fn rfc3339(time: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn encode_cursor(name: &str) -> String {
    name.bytes().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_cursor(cursor: &str) -> Option<String> {
    if !cursor.len().is_multiple_of(2) || cursor.len() > 2 * MAX_PATH_BYTES {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..cursor.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(cursor.get(index..index + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture {
        _outside: tempfile::TempDir,
        _root_dir: tempfile::TempDir,
        root: DataRoot,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        let root_dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let base = root_dir.path();
        std::fs::create_dir_all(base.join("2026-11/grid3/raw")).unwrap();
        for name in ["a.tiff", "b.tiff", "c.mrc", ".hidden.tiff"] {
            std::fs::write(base.join("2026-11/grid3").join(name), name).unwrap();
        }
        let outside = outside_dir.path().canonicalize().unwrap();
        std::fs::write(outside.join("secret.tiff"), "secret").unwrap();
        let root = DataRoot::parse(&format!("facility={}", base.display())).unwrap();
        Fixture {
            _outside: outside_dir,
            _root_dir: root_dir,
            root,
            outside,
        }
    }

    #[test]
    fn root_ids_and_arguments() {
        assert!(valid_root_id("facility"));
        assert!(valid_root_id("a"));
        assert!(valid_root_id("0-x"));
        assert!(!valid_root_id(""));
        assert!(!valid_root_id("-x"));
        assert!(!valid_root_id("Facility"));
        assert!(!valid_root_id("a_b"));
        assert!(!valid_root_id(&"a".repeat(33)));
        assert!(DataRoot::parse("facility").is_err());
        assert!(DataRoot::parse("facility=relative").is_err());
        assert!(DataRoot::parse("facility=/does/not/exist").is_err());
    }

    #[test]
    fn relative_path_rules() {
        for bad in [
            "..",
            "a/../b",
            "a/./b",
            ".",
            "/etc",
            "a//b",
            "a/",
            "a\\b",
            "a\0b",
            &"a".repeat(1025),
        ] {
            assert!(
                matches!(RelativePath::parse(bad), Err(PathError::Invalid(_))),
                "{bad:?}"
            );
        }
        assert_eq!(RelativePath::parse("").unwrap().as_str(), "");
        assert_eq!(RelativePath::parse("a/b.c").unwrap().file_name(), "b.c");
        assert!(RelativePath::parse(&"a".repeat(1024)).is_ok());
    }

    #[test]
    fn symlinks_cannot_escape_the_root() {
        let fixture = fixture();
        let base = &fixture.root.path;
        symlink(&fixture.outside, base.join("2026-11/escape-dir")).unwrap();
        symlink(
            fixture.outside.join("secret.tiff"),
            base.join("2026-11/grid3/z-escape.tiff"),
        )
        .unwrap();
        symlink(
            base.join("2026-11/grid3/a.tiff"),
            base.join("2026-11/inside.tiff"),
        )
        .unwrap();
        let resolve = |path: &str| RelativePath::parse(path).unwrap().resolve(base);
        assert!(matches!(
            resolve("2026-11/escape-dir"),
            Err(PathError::Outside)
        ));
        assert!(matches!(
            resolve("2026-11/escape-dir/secret.tiff"),
            Err(PathError::Outside)
        ));
        assert!(matches!(
            resolve("2026-11/grid3/z-escape.tiff"),
            Err(PathError::Outside)
        ));
        assert!(resolve("2026-11/inside.tiff").is_ok());
        assert!(matches!(
            list(&fixture.root, "2026-11/escape-dir", None),
            Err(PathError::Outside)
        ));
        let page = list(&fixture.root, "2026-11", None).unwrap();
        let names: Vec<&str> = page
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["grid3", "inside.tiff"]);
        assert_eq!(page.entries[1].kind, EntryKind::File);
        assert!(matches!(
            match_pattern(&fixture.root, "2026-11/grid3", "*.tiff"),
            Err(PathError::Outside)
        ));
        assert_eq!(
            match_pattern(&fixture.root, "2026-11/grid3", "?.tiff")
                .unwrap()
                .names,
            vec!["a.tiff", "b.tiff"]
        );
    }

    #[test]
    fn patterns() {
        let fixture = fixture();
        let matched = match_pattern(&fixture.root, "2026-11/grid3", "*.tiff").unwrap();
        assert_eq!(matched.directory, "2026-11/grid3");
        assert_eq!(matched.names, vec!["a.tiff", "b.tiff"]);
        assert!(matches!(
            match_pattern(&fixture.root, "2026-11/grid3", "*.eer"),
            Err(PathError::NoMatch)
        ));
        assert!(matches!(
            match_pattern(&fixture.root, "2026-11", "grid3/*.tiff"),
            Err(PathError::Invalid(_))
        ));
        assert!(matches!(
            match_pattern(&fixture.root, "2026-11", ""),
            Err(PathError::Invalid(_))
        ));
        assert!(matches!(
            match_pattern(&fixture.root, "2026-11", &"*".repeat(256)),
            Err(PathError::Invalid(_))
        ));
        assert!(matches!(
            match_pattern(&fixture.root, "../x", "*"),
            Err(PathError::Invalid(_))
        ));
        assert!(matches!(
            match_pattern(&fixture.root, "2026-11", "raw"),
            Err(PathError::NoMatch)
        ));
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("a*b?c", "aXXbYc"));
        assert!(glob_matches("*.tiff", ".tiff"));
        assert!(!glob_matches("a*b", "acd"));
        assert!(!glob_matches("?", ""));
        assert!(glob_matches("[x]", "[x]"));
    }

    #[test]
    fn listings_page_and_hide_dotfiles() {
        let fixture = fixture();
        let directory = fixture.root.path.join("many");
        std::fs::create_dir(&directory).unwrap();
        for index in 0..1005 {
            std::fs::write(directory.join(format!("f{index:04}")), "x").unwrap();
        }
        let first = list(&fixture.root, "many", None).unwrap();
        assert_eq!(first.entries.len(), PAGE_SIZE);
        assert_eq!(first.entries[0].name, "f0000");
        let cursor = first.next.clone().unwrap();
        let second = list(&fixture.root, "many", Some(&cursor)).unwrap();
        assert_eq!(second.entries.len(), 5);
        assert_eq!(second.entries[0].name, "f1000");
        assert!(second.next.is_none());
        assert!(list(&fixture.root, "many", Some("zz")).is_err());
        let grid = list(&fixture.root, "2026-11/grid3", None).unwrap();
        let names: Vec<&str> = grid
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["a.tiff", "b.tiff", "c.mrc", "raw"]);
        assert_eq!(grid.entries[0].bytes, Some(6));
        assert_eq!(grid.entries[3].bytes, None);
        assert_eq!(grid.entries[3].kind, EntryKind::Directory);
        assert!(list(&fixture.root, "missing", None).is_err());
        assert_eq!(list(&fixture.root, "", None).unwrap().entries.len(), 2);
    }
}
