//! Platform mechanics shared by the Rust pipelines (fastprep, SYNcro): a pipeline core decides each tool step and a
//! host runs it, as OS processes natively or through JavaScript drivers in the browser. Paths are `/`-separated
//! strings: real paths natively, virtual paths in the browser.

#[cfg(feature = "native")]
pub mod native;
pub mod record;
#[cfg(feature = "web")]
pub mod web;

/// One tool invocation. `argv[0]` is the tool name; the host resolves it.
pub struct Step {
    pub argv: Vec<String>,
    /// Environment for this step only (e.g. FSLOUTPUTTYPE for niimath's output format), in command-log order.
    pub env: Vec<(String, String)>,
    /// Holds a GPU slot while running (brainchop, synthsr).
    pub gpu: bool,
}

impl Step {
    pub fn env_var(&self, key: &str) -> Option<&str> {
        self.env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

pub struct Exit {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// File identity for resume records: (size, modification time in ns).
pub type Stat = (u64, u128);

#[allow(async_fn_in_trait)] // one implementation per target; never used as dyn
pub trait Host {
    async fn run(&self, step: &Step) -> Result<Exit, String>;
    /// At most `len` bytes from `offset`; fewer at end of file.
    async fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String>;
    /// Whole small text file; error if larger than `limit` bytes.
    async fn read_text(&self, path: &str, limit: usize) -> Result<String, String>;
    async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String>;
    async fn append(&self, path: &str, bytes: &[u8]) -> Result<(), String>;
    fn exists(&self, path: &str) -> bool;
    /// Regular files only.
    fn stat(&self, path: &str) -> Option<Stat>;
    /// Files below `dir`, recursively, as paths relative to it.
    fn list(&self, dir: &str) -> Vec<String>;
    fn mkdirs(&self, dir: &str) -> Result<(), String>;
    fn remove(&self, path: &str);
    fn rename(&self, from: &str, to: &str) -> Result<(), String>;
    fn copy(&self, from: &str, to: &str) -> Result<(), String>;
    /// Seconds since the Unix epoch.
    fn now(&self) -> f64;
    /// Local wall time as `YYYY-MM-DD HH:MM`.
    fn local_time(&self) -> String;
    fn log(&self, line: &str);
}

/// Parent directory of a `/`-separated path.
pub fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

pub fn file_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, f)| f)
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// Shell quoting, as Python's `shlex.quote`, for the command log.
pub fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\"'\"'"))
    }
}
