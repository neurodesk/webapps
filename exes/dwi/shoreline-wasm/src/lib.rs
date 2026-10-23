// SPDX-License-Identifier: Apache-2.0
//! The `shoreline` command line for the browser: the page adds the input files to a
//! `Session`, runs it with the same arguments as the native binary, and takes the output
//! files. Both run `dwi_shoreline::cli::run`, so they give the same result.
//!
//! The threaded module (feature `threads`) exports `initThreadPool`, which the page awaits
//! before `run`; without it, the module runs on the calling thread.

use std::collections::HashMap;

use dwi_shoreline::cli::{self, Files};
use wasm_bindgen::prelude::*;

#[cfg(all(target_arch = "wasm32", feature = "threads"))]
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn report_panic(message: &str);
}

fn seconds() -> f64 {
    js_sys::Date::now() / 1000.0
}

#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| report_panic(&info.to_string())));
    dwi_shoreline::set_clock(seconds);
}

/// Input and output files, by name.
#[wasm_bindgen]
#[derive(Default)]
pub struct Session {
    files: HashMap<String, Vec<u8>>,
}

impl Files for Session {
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| format!("{path}: no such file"))
    }

    fn take(&mut self, path: &str) -> Result<Vec<u8>, String> {
        self.files
            .remove(path)
            .ok_or_else(|| format!("{path}: no such file"))
    }

    fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), String> {
        self.files.insert(path.to_string(), bytes);
        Ok(())
    }
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Session {
        Session::default()
    }

    /// Adds (or replaces) the file `name`.
    #[wasm_bindgen(js_name = addFile)]
    pub fn add_file(&mut self, name: String, bytes: Vec<u8>) {
        self.files.insert(name, bytes);
    }

    /// The names of the files held, sorted.
    #[wasm_bindgen(js_name = fileNames)]
    pub fn file_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.files.keys().cloned().collect();
        names.sort();
        names
    }

    /// Removes the file `name` and returns its bytes.
    #[wasm_bindgen(js_name = takeFile)]
    pub fn take_file(&mut self, name: &str) -> Option<Vec<u8>> {
        self.files.remove(name)
    }

    /// Runs the command line on `argv` (eddy-style options, without the program name).
    /// `log` receives each progress line. The series named by `--imain` is consumed.
    pub fn run(&mut self, argv: Vec<String>, log: &js_sys::Function) -> Result<(), JsValue> {
        single_thread_pool();
        cli::run(&argv, self, &mut |line| {
            let _ = log.call1(&JsValue::NULL, &JsValue::from_str(line));
        })
        .map_err(|e| JsValue::from_str(&e))
    }
}

/// Without threads, rayon's pool is the calling thread: WebAssembly cannot spawn one.
fn single_thread_pool() {
    #[cfg(all(target_arch = "wasm32", not(feature = "threads")))]
    {
        static POOL: std::sync::Once = std::sync::Once::new();
        POOL.call_once(|| {
            let _ = rayon::ThreadPoolBuilder::new()
                .num_threads(1)
                .use_current_thread()
                .build_global();
        });
    }
}
